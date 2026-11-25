import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';

export const PROVIDER_IDENTITY_PORT = Symbol('PROVIDER_IDENTITY_PORT');

export interface ProviderIdentity {
  providerId?: string;
  subject: string;
}

export interface ProviderIdentityPort {
  authenticate(request: Request): Promise<ProviderIdentity>;
}

/** The challenge currently runs without authentication; a real adapter can replace this provider. */
@Injectable()
export class NoopProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<ProviderIdentity> {
    return { subject: 'anonymous' };
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY_PORT) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { providerIdentity?: ProviderIdentity }>();
    request.providerIdentity = await this.identity.authenticate(request);
    return true;
  }
}
