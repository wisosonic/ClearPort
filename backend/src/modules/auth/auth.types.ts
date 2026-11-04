/** Established by JwtAuthGuard from a VERIFIED membership — the only source of tenant identity. */
export interface AuthContext {
  userId: string;
  email: string;
  tenantId: string;
  membershipId: string;
  /** refresh-token family id; revoking the family ends the session */
  sessionId: string;
  permissions: ReadonlySet<string>;
}

export interface AccessTokenPayload {
  sub: string; // user id
  tid: string; // tenant id (verified against membership on every request)
  sid: string; // session family id
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}
