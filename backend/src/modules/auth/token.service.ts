import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ENV, type Env } from '../../config/env';
import type { AccessTokenPayload } from './auth.types';

const ISSUER = 'clearport';
const AUDIENCE = 'clearport-api';
const DOWNLOAD_AUDIENCE = 'clearport-download';

export interface DownloadTokenPayload {
  sub: string; // document id
  tid: string; // tenant id
  uid: string; // user who requested the link
  ver: number; // version number
  disp: 'attachment' | 'inline';
}

@Injectable()
export class TokenService {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get accessTtlSeconds() {
    return this.env.ACCESS_TOKEN_TTL_SECONDS;
  }

  get refreshTtlMs() {
    return this.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  signAccess(payload: AccessTokenPayload): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret: this.env.JWT_ACCESS_SECRET,
      algorithm: 'HS256',
      expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  }

  async verifyAccess(token: string): Promise<AccessTokenPayload> {
    const p = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
      secret: this.env.JWT_ACCESS_SECRET,
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (!p.sub || !p.tid || !p.sid) throw new Error('Malformed access token');
    return p;
  }

  /**
   * Short-lived signed download link token (spec 9.4). Different audience from access tokens, so
   * one can never be used as the other. The download endpoint re-verifies ownership when used.
   */
  signDownload(payload: DownloadTokenPayload, ttlSeconds: number): Promise<string> {
    return this.jwt.signAsync({ ...payload }, {
      secret: this.env.JWT_ACCESS_SECRET, algorithm: 'HS256', expiresIn: ttlSeconds,
      issuer: ISSUER, audience: DOWNLOAD_AUDIENCE,
    });
  }

  async verifyDownload(token: string): Promise<DownloadTokenPayload> {
    const p = await this.jwt.verifyAsync<DownloadTokenPayload>(token, {
      secret: this.env.JWT_ACCESS_SECRET, algorithms: ['HS256'], issuer: ISSUER, audience: DOWNLOAD_AUDIENCE,
    });
    if (!p.sub || !p.tid || !p.uid || !p.ver) throw new Error('Malformed download token');
    return p;
  }

  /** Opaque random refresh token. Only its SHA-256 hash is stored. */
  newRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(48).toString('base64url');
    return { token, hash: TokenService.hash(token) };
  }

  static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
