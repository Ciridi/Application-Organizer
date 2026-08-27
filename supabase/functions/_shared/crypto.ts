const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function getEncryptionKey(): Promise<CryptoKey> {
  const encodedKey = Deno.env.get("GOOGLE_TOKEN_ENCRYPTION_KEY");

  if (!encodedKey) {
    throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is not configured.");
  }

  const rawKey = base64ToBytes(encodedKey);

  if (rawKey.byteLength !== 32) {
    throw new Error(
      "GOOGLE_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    );
  }

  return crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
};

export async function encryptSecret(
  plaintext: string,
): Promise<EncryptedSecret> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    textEncoder.encode(plaintext),
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptSecret(
  secret: EncryptedSecret,
): Promise<string> {
  const key = await getEncryptionKey();

  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(secret.iv),
    },
    key,
    base64ToBytes(secret.ciphertext),
  );

  return textDecoder.decode(decrypted);
}
