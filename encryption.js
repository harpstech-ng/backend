import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

export function encrypt(text, key) {
  if (!text) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key, 'hex'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedText, key) {
  if (!encryptedText) return null;
  const [ivHex, authTagHex, encryptedHex] = encryptedText.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
