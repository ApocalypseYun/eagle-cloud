import * as https from 'node:https'
import * as querystring from 'node:querystring'

const OAUTH_AUTHORIZE_URL = 'https://openapi.baidu.com/oauth/2.0/authorize'
const OAUTH_TOKEN_URL = 'https://openapi.baidu.com/oauth/2.0/token'

// Access token validity: 30 days. Refresh 1 hour before expiry.
const TOKEN_REFRESH_BUFFER_MS = 60 * 60 * 1000

export interface BaiduTokens {
  readonly accessToken: string
  readonly refreshToken: string
  readonly tokenExpiresAt: number
}

export interface AuthConfig {
  readonly appKey: string
  readonly secretKey: string
  readonly redirectUri: string
}

interface TokenResponse {
  readonly access_token: string
  readonly refresh_token: string
  readonly expires_in: number
}

export type ConfigPersister = (tokens: BaiduTokens) => Promise<void>

export class BaiduPanAuth {
  private readonly config: AuthConfig
  private tokens: BaiduTokens | null
  private readonly persistTokens: ConfigPersister

  constructor(
    config: AuthConfig,
    tokens: BaiduTokens | null,
    persistTokens: ConfigPersister
  ) {
    this.config = config
    this.tokens = tokens
    this.persistTokens = persistTokens
  }

  getAuthUrl(): string {
    const params = querystring.stringify({
      response_type: 'code',
      client_id: this.config.appKey,
      redirect_uri: this.config.redirectUri,
      scope: 'basic,netdisk',
    })
    return `${OAUTH_AUTHORIZE_URL}?${params}`
  }

  async exchangeCode(code: string): Promise<BaiduTokens> {
    const params = querystring.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: this.config.appKey,
      client_secret: this.config.secretKey,
      redirect_uri: this.config.redirectUri,
    })

    const response = await this.requestToken(params)
    const tokens = this.buildTokens(response)
    this.tokens = tokens
    await this.persistTokens(tokens)
    return tokens
  }

  async refreshToken(): Promise<BaiduTokens> {
    if (!this.tokens) {
      throw new Error('No refresh token available. Re-authenticate required.')
    }

    const params = querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refreshToken,
      client_id: this.config.appKey,
      client_secret: this.config.secretKey,
    })

    const response = await this.requestToken(params)
    const tokens = this.buildTokens(response)
    this.tokens = tokens
    await this.persistTokens(tokens)
    return tokens
  }

  isTokenValid(): boolean {
    if (!this.tokens) return false
    return Date.now() < this.tokens.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS
  }

  async getAccessToken(): Promise<string> {
    if (!this.tokens) {
      throw new Error('Not authenticated. Call authenticate() first.')
    }
    if (!this.isTokenValid()) {
      await this.refreshToken()
    }
    return this.tokens!.accessToken
  }

  isAuthenticated(): boolean {
    return this.tokens !== null
  }

  private buildTokens(response: TokenResponse): BaiduTokens {
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      tokenExpiresAt: Date.now() + response.expires_in * 1000,
    }
  }

  private requestToken(body: string): Promise<TokenResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(OAUTH_TOKEN_URL)
      const options: https.RequestOptions = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      }

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          try {
            const json = JSON.parse(raw) as Record<string, unknown>
            if (json.error) {
              reject(new Error(`BaiduPan OAuth error: ${json.error_description || json.error}`))
              return
            }
            resolve(json as unknown as TokenResponse)
          } catch (e) {
            reject(new Error(`Failed to parse token response: ${raw}`))
          }
        })
      })

      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }
}
