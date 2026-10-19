import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id with the library defaults (m=19456 KiB, t=2, p=1), which is the OWASP-recommended
 * minimum configuration. Parameters are embedded in the hash, so they can be raised later and
 * old hashes keep verifying.
 */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a server error.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same CPU time as a real verification, so login for an unknown email is not
 * measurably faster than login with a wrong password.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-used-only-for-timing');
  await verifyPassword(await dummyHash, password);
}
