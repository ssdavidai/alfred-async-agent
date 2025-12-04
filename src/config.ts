/**
 * Config API Handler
 *
 * Manages VM configuration including Anthropic API key storage.
 * All sensitive values are encrypted using VM_ENCRYPTION_SECRET.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { getPrismaClient } from './db/client.js';

// Encryption constants
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Get encryption key from environment
 */
function getEncryptionKey(): Buffer {
  const secret = process.env.VM_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error('VM_ENCRYPTION_SECRET is not configured');
  }
  // Create a 32-byte key from the secret
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a value
 */
function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encrypted
  return `encrypted:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt a value
 */
function decrypt(encryptedValue: string): string {
  if (!encryptedValue.startsWith('encrypted:')) {
    // Value is not encrypted (plain text)
    return encryptedValue;
  }

  const parts = encryptedValue.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted value format');
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(parts[1], 'base64');
  const authTag = Buffer.from(parts[2], 'base64');
  const encrypted = parts[3];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Mask an API key for display
 */
function maskApiKey(key: string): string {
  if (!key || key.length < 12) {
    return '****';
  }
  // Show first 7 chars (sk-ant-) and last 4 chars
  return `${key.substring(0, 7)}...${key.substring(key.length - 4)}`;
}

/**
 * GET /api/config
 * Returns config status without exposing actual values
 */
export async function getConfig(req: Request, res: Response): Promise<void> {
  try {
    const prisma = getPrismaClient();

    // Get anthropic_api_key config
    const apiKeyConfig = await prisma.config.findUnique({
      where: { key: 'anthropic_api_key' },
    });

    let hasApiKey = false;
    let maskedApiKey: string | null = null;
    let apiKeyUpdatedAt: Date | null = null;

    if (apiKeyConfig && apiKeyConfig.value) {
      try {
        const decrypted = decrypt(apiKeyConfig.value);
        hasApiKey = decrypted.startsWith('sk-ant-');
        maskedApiKey = maskApiKey(decrypted);
        apiKeyUpdatedAt = apiKeyConfig.updatedAt;
      } catch (e) {
        console.error('[Config] Failed to decrypt API key:', e);
        hasApiKey = false;
      }
    }

    res.json({
      hasApiKey,
      maskedApiKey,
      apiKeyUpdatedAt,
    });
  } catch (error) {
    console.error('[Config] Error getting config:', error);
    res.status(500).json({ error: 'Failed to get config' });
  }
}

/**
 * POST /api/config
 * Saves configuration (anthropic_api_key)
 */
export async function saveConfig(req: Request, res: Response): Promise<void> {
  try {
    const { anthropic_api_key } = req.body;

    if (!anthropic_api_key) {
      res.status(400).json({ error: 'anthropic_api_key is required' });
      return;
    }

    // Validate API key format
    if (!anthropic_api_key.startsWith('sk-ant-')) {
      res.status(400).json({ error: 'Invalid API key format. Must start with sk-ant-' });
      return;
    }

    if (anthropic_api_key.length < 20) {
      res.status(400).json({ error: 'API key appears to be too short' });
      return;
    }

    const prisma = getPrismaClient();

    // Encrypt and store the API key
    const encryptedKey = encrypt(anthropic_api_key);

    await prisma.config.upsert({
      where: { key: 'anthropic_api_key' },
      update: { value: encryptedKey },
      create: { key: 'anthropic_api_key', value: encryptedKey },
    });

    console.log('[Config] Anthropic API key saved successfully');

    res.json({
      success: true,
      message: 'API key saved successfully',
      maskedApiKey: maskApiKey(anthropic_api_key),
    });
  } catch (error) {
    console.error('[Config] Error saving config:', error);
    res.status(500).json({ error: 'Failed to save config' });
  }
}

/**
 * Get decrypted Anthropic API key for internal use
 */
export async function getAnthropicApiKey(): Promise<string | null> {
  try {
    const prisma = getPrismaClient();
    const config = await prisma.config.findUnique({
      where: { key: 'anthropic_api_key' },
    });

    if (!config || !config.value) {
      return null;
    }

    return decrypt(config.value);
  } catch (error) {
    console.error('[Config] Error getting Anthropic API key:', error);
    return null;
  }
}
