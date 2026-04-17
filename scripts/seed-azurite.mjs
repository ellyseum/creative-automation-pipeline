/**
 * Seed Azurite with test assets from the local assets/ directory.
 * Run: node scripts/seed-azurite.mjs
 * Requires: docker-compose up -d (Azurite on localhost:10000)
 *
 * Uploads all images from assets/ to the Azurite blob container,
 * making them accessible via the AzureBlobStorage adapter.
 */

import { BlobServiceClient } from '@azure/storage-blob';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const AZURITE_CONN = 'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;';
const CONTAINER = 'pipeline-assets';

async function listFilesRecursive(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(full));
    } else if (/\.(png|jpg|jpeg|webp)$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const contentTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

async function main() {
  console.log('Connecting to Azurite...');
  const client = BlobServiceClient.fromConnectionString(AZURITE_CONN);
  const container = client.getContainerClient(CONTAINER);
  await container.createIfNotExists({ access: 'blob' });

  const files = await listFilesRecursive('assets');
  console.log(`Found ${files.length} assets to upload.\n`);

  for (const file of files) {
    const data = await readFile(file);
    const ext = extname(file).toLowerCase();
    const ct = contentTypes[ext] || 'application/octet-stream';

    await container.getBlockBlobClient(file).uploadData(data, {
      blobHTTPHeaders: { blobContentType: ct },
    });
    console.log(`  ✓ ${file} (${(data.length / 1024).toFixed(0)} KB)`);
  }

  // Verify by listing
  const blobs = [];
  for await (const blob of container.listBlobsFlat()) {
    blobs.push(blob.name);
  }
  console.log(`\nDone: ${blobs.length} blobs in container "${CONTAINER}".`);
}

main().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
