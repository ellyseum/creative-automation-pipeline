/**
 * Adapter factory — resolves the right concrete implementations based on env vars.
 *
 * This is the composition root for dependency injection. Called once at pipeline
 * start, returns a wired Adapters bundle that gets passed to the RunContext.
 * From this point on, the pipeline only sees port interfaces — never SDKs.
 *
 * Provider selection:
 *   IMAGE_PROVIDER=imagen (default) | firefly | openai | stub
 *   LLM_PROVIDER=gemini (default) | openai
 *   STORAGE_BACKEND=local (default) | azure
 *
 * Fallback: if GEMINI_API_KEY is missing, all AI adapters fall back to stubs.
 * This allows the pipeline structure to be tested without any API keys.
 */

import { optional, must } from '../infra/env.js';
import type { Adapters } from '../infra/run-context.js';

import { GeminiAdapter } from './gemini-llm.js';
import { ImagenGeneratorAdapter } from './imagen-generator.js';
import { LocalFsStorage } from './local-fs-storage.js';
import { AzureBlobStorage } from './azure-blob-storage.js';
import { JsonAssetIndex } from './json-asset-index.js';
import { StubGeneratorAdapter } from './stub-generator.js';
import { FireflyGeneratorAdapter } from './firefly-generator.js';

export function resolveAdapters(): Adapters {
  // --- LLM + Multimodal + Embedding ---
  // Gemini covers all three via one adapter. If no key, we'd need stubs
  // (not implemented for LLM — fail fast rather than produce garbage).
  const geminiKey = optional('GEMINI_API_KEY');

  if (!geminiKey) {
    throw new Error(
      'GEMINI_API_KEY is required. Set it in .env or environment.\n' +
      'Get a key from https://aistudio.google.com/app/apikey'
    );
  }

  const gemini = new GeminiAdapter({ apiKey: geminiKey });

  // --- Image Generator ---
  // Selection order: explicit env var > Firefly if creds available > Imagen default > stub
  const imageProviderName = optional('IMAGE_PROVIDER', 'imagen');
  let imageGen;

  switch (imageProviderName) {
    case 'firefly': {
      const clientId = optional('ADOBE_CLIENT_ID');
      const clientSecret = optional('ADOBE_CLIENT_SECRET');
      if (!clientId || !clientSecret) {
        console.warn('⚠ IMAGE_PROVIDER=firefly but ADOBE_CLIENT_ID/SECRET not set — falling back to Imagen');
        imageGen = new ImagenGeneratorAdapter({ apiKey: geminiKey });
      } else {
        console.log('✓ Using Adobe Firefly Services');
        imageGen = new FireflyGeneratorAdapter({ clientId, clientSecret });
      }
      break;
    }
    case 'stub':
      // Stub mode — no API calls, placeholder images
      imageGen = new StubGeneratorAdapter();
      break;
    case 'imagen':
    default:
      imageGen = new ImagenGeneratorAdapter({ apiKey: geminiKey });
      break;
  }

  // --- Storage ---
  // Local FS by default, Azure Blob when STORAGE_BACKEND=azure
  const storageBackend = optional('STORAGE_BACKEND', 'local');
  let storage;

  if (storageBackend === 'azure') {
    const connStr = must('AZURE_STORAGE_CONNECTION_STRING');
    storage = new AzureBlobStorage({ connectionString: connStr });
    console.log('✓ Using Azure Blob Storage');
  } else {
    storage = new LocalFsStorage();
  }

  // --- Asset Index ---
  // Always JSON-file-backed for the demo. Production would swap in
  // Azure AI Search or pgvector via the same interface.
  const assetIndex = new JsonAssetIndex();

  return {
    llm: gemini,
    multimodal: gemini,
    embedding: gemini,
    imageGen,
    storage,
    assetIndex,
  };
}
