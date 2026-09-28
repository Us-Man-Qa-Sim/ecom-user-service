import { AuthTokens } from '@us-man-qa-sim/ecom-contracts/generated/user';
import { IssuedTokens } from './auth.service';

function dateToTimestamp(date: Date): { seconds: number; nanos: number } {
  const millis = date.getTime();
  return {
    seconds: Math.trunc(millis / 1000),
    nanos: (millis % 1000) * 1_000_000,
  };
}

export function toProtoAuthTokens(tokens: IssuedTokens): AuthTokens {
  return {
    accessToken: tokens.access.token,
    refreshToken: tokens.refresh.token,
    accessTokenExpiresAt: dateToTimestamp(tokens.access.expiresAt),
  };
}
