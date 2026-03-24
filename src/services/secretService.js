const crypto = require('crypto');

const SECRET_PREFIX = 'enc:v1';
const SECRET_KEY_SOURCE = process.env.ACCOUNT_SECRET_KEY || process.env.JWT_SECRET || process.env.ADMIN_PASSWORD || '';

function getKey() {
    if (!SECRET_KEY_SOURCE) {
        throw new Error('No secret key configured for account encryption');
    }
    return crypto.createHash('sha256').update(String(SECRET_KEY_SOURCE)).digest();
}

function encryptSecret(value) {
    if (!value) return '';
    if (typeof value !== 'string') return value;
    if (value.startsWith(`${SECRET_PREFIX}:`)) return value;

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
        SECRET_PREFIX,
        iv.toString('base64'),
        tag.toString('base64'),
        encrypted.toString('base64'),
    ].join(':');
}

function decryptSecret(value) {
    if (!value) return '';
    if (typeof value !== 'string') return value;
    if (!value.startsWith(`${SECRET_PREFIX}:`)) return value;

    const [, , ivB64, tagB64, encryptedB64] = value.split(':');
    if (!ivB64 || !tagB64 || !encryptedB64) {
        throw new Error('Malformed encrypted secret');
    }

    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        getKey(),
        Buffer.from(ivB64, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedB64, 'base64')),
        decipher.final(),
    ]);

    return decrypted.toString('utf8');
}

module.exports = {
    encryptSecret,
    decryptSecret,
};
