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
import { StubLLMAdapter } from './stub-llm.js';
import { FireflyGeneratorAdapter } from './firefly-generator.js';

export function resolveAdapters(): Adapters {
  // --- Full stub mode ---
  // IMAGE_PROVIDER=stub with no GEMINI_API_KEY = everything stubbed.
  // Useful for: testing pipeline structure, CI, demo without API keys.
  const imageProviderName = optional('IMAGE_PROVIDER', 'imagen');
  const geminiKey = optional('GEMINI_API_KEY');

  if (!geminiKey || imageProviderName === 'stub') {
    if (!geminiKey && imageProviderName !== 'stub') {
      console.warn('⚠ No GEMINI_API_KEY — running in full stub mode (no real AI calls)');
    }

    const stub = new StubLLMAdapter();
    return {
      llm: stub,
      multimodal: stub,
      embedding: stub,
      imageGen: new StubGeneratorAdapter(),
      storage: new LocalFsStorage(),
      assetIndex: new JsonAssetIndex(),
    };
  }

  const gemini = new GeminiAdapter({ apiKey: geminiKey });

  // --- Image Generator ---
  // Selection order: explicit env var > Firefly if creds available > Imagen default
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
