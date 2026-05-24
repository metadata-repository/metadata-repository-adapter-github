import {
  assertModuleManifest,
  assertModuleName,
  assertSafeRelativePath,
  registerMetadataRepositoryAdapter,
  sortSemverDescending,
  type FoundModule,
  type MetadataRepositoryAdapter,
  type ModuleManifest,
  type ModuleVersion,
  type PublishingFile,
  type PublishInput,
  type PublishResult,
  type SearchInput,
  type SearchResult
} from '#modules/metadata-repository-adapter/src/adapter.js';
import { DuplicateFilePath } from '#modules/metadata-repository-adapter/src/errors/duplicate-file-path.js';
import { ModuleVersionAlreadyExists } from '#modules/metadata-repository-adapter/src/errors/module-version-already-exists.js';
import { loadConfig, type Config } from './config.js';
import { GitHub, type GitHubRepository } from './github.js';

export const metadataRepositoryAdapter = registerMetadataRepositoryAdapter({
  async create() {
    return new GitHubMetadataRepositoryAdapter(loadConfig());
  }
});

class GitHubMetadataRepositoryAdapter implements MetadataRepositoryAdapter {
  readonly #github: GitHub;

  constructor(config: Config) {
    this.#github = new GitHub(config);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    assertModuleName(input.manifest.name);
    assertModuleManifest(input.manifest);
    validateFiles(input.files);

    const repository = await this.#github.ensureRepository(input.manifest);

    if (
      await this.#github.versionExists(
        input.manifest.name,
        input.manifest.version
      )
    ) {
      throw new ModuleVersionAlreadyExists();
    }

    const head =
      (await this.#github.getBranchHead(
        input.manifest.name,
        repository.default_branch
      )) ??
      (await this.#github.initializeRepository(
        input.manifest.name,
        repository.default_branch
      ));

    const tree = await this.#github.createTree(
      input.manifest.name,
      input.files
    );
    const commit = await this.#github.createCommit(
      input.manifest.name,
      tree.sha,
      `Publish ${input.manifest.name}@${input.manifest.version}`,
      head
    );

    await this.#github.createVersionTag(
      input.manifest.name,
      input.manifest.version,
      commit.sha
    );
    await this.#github.upsertBranch(
      input.manifest.name,
      repository.default_branch,
      commit.sha,
      true
    );

    return this.#createPublishResult(input.manifest, repository);
  }

  async search(input: SearchInput): Promise<SearchResult> {
    const repositories = await this.#github.listRepositories();
    const query = input.query.trim().toLowerCase();
    const matches = repositories
      .filter((repository) => isRepositoryMatch(repository, query))
      .toSorted(
        (left, right) =>
          rankRepository(right, query) - rankRepository(left, query)
      );
    const paged = matches.slice(input.skip, input.skip + input.take);
    const objects = await Promise.all(
      paged.map(async (repository) => this.#createSearchResult(repository))
    );

    return {
      objects,
      total: matches.length
    };
  }

  async listVersions(name: string): Promise<string[]> {
    assertModuleName(name);

    return sortSemverDescending(await this.#github.listVersions(name));
  }

  async getVersion(name: string, version: string): Promise<ModuleVersion> {
    assertModuleName(name);

    const [repository, manifest] = await Promise.all([
      this.#github.getRepository(name),
      this.#github.getManifest(name, version)
    ]);

    assertModuleManifest(manifest);

    return this.#createModuleVersion(manifest, repository);
  }

  async downloadArchive(
    name: string,
    version: string
  ): Promise<ReadableStream> {
    assertModuleName(name);

    return this.#github.downloadArchive(name, version);
  }

  async #createSearchResult(
    repository: GitHubRepository
  ): Promise<FoundModule> {
    const versions = await this.listVersions(repository.name);
    const latestVersion = versions[0] ?? '';

    return {
      name: repository.name,
      description: repository.description ?? '',
      version: latestVersion,
      repositoryUrl: repository.html_url
    };
  }

  #createPublishResult(
    manifest: ModuleManifest,
    repository: GitHubRepository
  ): PublishResult {
    return {
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      repositoryUrl: repository.html_url,
      archiveUrl: this.#github.createArchiveUrl(manifest.name, manifest.version)
    };
  }

  #createModuleVersion(
    manifest: ModuleManifest,
    repository: GitHubRepository
  ): ModuleVersion {
    return {
      manifest,
      repositoryUrl: repository.html_url,
      archiveUrl: this.#github.createArchiveUrl(manifest.name, manifest.version)
    };
  }
}

function validateFiles(files: PublishingFile[]) {
  const paths = new Set<string>();
  for (const file of files) {
    assertSafeRelativePath(file.path);
    if (paths.has(file.path)) {
      throw new DuplicateFilePath(`${file.path}: duplicate file path.`);
    }

    paths.add(file.path);
  }
}

function isRepositoryMatch(repository: GitHubRepository, query: string) {
  if (!query) {
    return true;
  }

  const description = repository.description?.toLowerCase() ?? '';

  return (
    repository.name.toLowerCase().includes(query) || description.includes(query)
  );
}

function rankRepository(repository: GitHubRepository, query: string) {
  if (!query) {
    return 0;
  }

  const name = repository.name.toLowerCase();
  if (name === query) {
    return 3;
  }

  if (name.startsWith(query)) {
    return 2;
  }

  return 1;
}
