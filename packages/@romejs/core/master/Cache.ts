/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  WorkerCompileResult,
  WorkerAnalyzeDependencyResult,
} from '../common/bridges/WorkerBridge';
import {ModuleSignature} from '@romejs/js-analysis';
import Master from './Master';
import {DEFAULT_PROJECT_CONFIG, ProjectDefinition} from '@romejs/project';
import {VERSION} from '../common/constants';
import {PartialDiagnostics} from '@romejs/diagnostics';
import {AbsoluteFilePath, AbsoluteFilePathMap} from '@romejs/path';
import {createDirectory, writeFile, readFileText, unlink} from '@romejs/fs';

type CacheEntry = {
  version: string;
  configHash: string;
  projectDir: string;
  mtime: number;
  compile: {
    [key: string]: WorkerCompileResult;
  };
  lint: undefined | PartialDiagnostics;
  analyzeDependencies: undefined | WorkerAnalyzeDependencyResult;
  moduleSignature: undefined | ModuleSignature;
};

// Basic checks to determine if we can consider a and b to be mergable
function areEntriesEqual(a: CacheEntry, b: CacheEntry): boolean {
  if (a.version !== b.version) {
    // Outdated cache file
    return false;
  }

  if (a.configHash !== b.configHash) {
    // Project config has been changed since this was last updated
    return false;
  }

  if (a.mtime !== b.mtime) {
    // File has been changed
    return false;
  }

  return true;
}

export default class Cache {
  constructor(master: Master) {
    this.master = master;
    this.loadedEntries = new AbsoluteFilePathMap();
    this.disabled = process.env.ROME_CACHE === '0';
    this.cachePath = master.userConfig.cachePath;
  }

  disabled: boolean;
  loadedEntries: AbsoluteFilePathMap<CacheEntry>;
  master: Master;
  cachePath: AbsoluteFilePath;

  async init() {
    this.master.memoryFs.deletedFileEvent.subscribe(filename => {
      return this.master.cache.handleDeleted(filename);
    });

    const {memoryFs} = this.master;
    await createDirectory(this.cachePath, {recursive: true});
    await memoryFs.watch(this.cachePath, DEFAULT_PROJECT_CONFIG);
  }

  async createEmptyEntry(filename: AbsoluteFilePath): Promise<CacheEntry> {
    const {projectManager, memoryFs} = this.master;

    const project: ProjectDefinition = await projectManager.assertProject(
      filename,
    );

    const configHashes = [...project.meta.configHashes];
    const pkg = this.master.memoryFs.getOwnedManifest(filename);
    if (pkg !== undefined) {
      configHashes.push(pkg.hash);
    }

    const entry: CacheEntry = {
      version: VERSION,
      projectDir: project.folder.join(),
      configHash: configHashes.join(';'),
      mtime: memoryFs.getMtime(filename),
      compile: {},
      analyzeDependencies: undefined,
      moduleSignature: undefined,
      lint: undefined,
    };

    return entry;
  }

  getCacheFilename(filename: AbsoluteFilePath): AbsoluteFilePath {
    const uid = this.master.projectManager.getUid(filename);
    return this.cachePath.append(uid);
  }

  async handleDeleted(filename: AbsoluteFilePath) {
    // Handle the file not existing
    const cacheFilename = this.getCacheFilename(filename);
    await unlink(cacheFilename);
    this.loadedEntries.delete(filename);
  }

  async get(filename: AbsoluteFilePath): Promise<CacheEntry> {
    const emptyEntry = await this.createEmptyEntry(filename);

    // If we have a loaded memory entry, make sure it's valid compared to the default entry (file changes etc)
    let loaded = this.loadedEntries.get(filename);
    if (loaded !== undefined && areEntriesEqual(loaded, emptyEntry)) {
      return emptyEntry;
    }

    if (this.disabled) {
      return emptyEntry;
    }

    const cacheFilename = this.getCacheFilename(filename);
    const entry = await this.checkPossibleDiskCacheEntry(
      cacheFilename,
      emptyEntry,
    );
    this.loadedEntries.set(filename, entry);
    return entry;
  }

  async checkPossibleDiskCacheEntry(
    cacheFilename: AbsoluteFilePath,
    emptyEntry: CacheEntry,
  ): Promise<CacheEntry> {
    const {memoryFs} = this.master;

    if (!memoryFs.exists(cacheFilename)) {
      return emptyEntry;
    }

    try {
      const json = await readFileText(cacheFilename);
      const obj = JSON.parse(json);

      if (areEntriesEqual(emptyEntry, obj)) {
        return {...emptyEntry, ...obj};
      } else {
        // If the entries aren't equal then there's something wrong with the cache entry
        await this.handleDeleted(cacheFilename);
        return emptyEntry;
      }
    } catch (err) {
      // TODO add some heuristic to only catch json and cache permission errors
      return emptyEntry;
    }
  }

  async update(
    filename: AbsoluteFilePath,
    partialEntryCallback:
      | Partial<CacheEntry>
      | ((entry: CacheEntry) => Partial<CacheEntry>),
  ) {
    const currEntry = await this.get(filename);
    const partialEntry: Partial<CacheEntry> =
      typeof partialEntryCallback === 'function'
        ? partialEntryCallback(currEntry)
        : partialEntryCallback;

    const entry: CacheEntry = {
      ...currEntry,
      ...partialEntry,
    };

    // TODO should batch these and write during idle time
    const cacheFilename = this.getCacheFilename(filename);
    this.loadedEntries.set(filename, entry);

    if (this.disabled) {
      return;
    }

    await createDirectory(cacheFilename.getParent(), {
      recursive: true,
    });
    await writeFile(cacheFilename, JSON.stringify(entry, null, '  '));
  }
}
