import { InternalServerError } from '#modules/metadata-error/src/errors/internal-server-error.js';
import { MetadataError } from '#modules/metadata-error/src/metadata-error.js';
import {
  assertModuleName,
  isSemver,
  type ModuleManifest,
  type PublishingFile
} from '#modules/metadata-repository-adapter/src/adapter.js';
import { ArchiveNotFound } from '#modules/metadata-repository-adapter/src/errors/archive-not-found.js';
import { ModuleNotFound } from '#modules/metadata-repository-adapter/src/errors/module-not-found.js';
import type { Config } from './config.js';
import {
  GITHUB_API,
  METADATA_REPOSITORY_GITHUB_REPO_VISIBILITY
} from './constants.js';

export interface GitHubRepository {
  name: string;
  description?: string | null;
  html_url: string;
  default_branch: string;
}

export interface GitHubTree {
  sha: string;
}

export interface GitHubCommit {
  sha: string;
}

interface GitHubRepositoryUrl {
  html_url: string;
}

interface GitHubRef {
  object: {
    sha: string;
  };
}

interface GitHubBlob {
  sha: string;
}

interface GitHubContentFile {
  content: string;
  encoding: string;
}

interface GitHubContentWriteResult {
  commit: {
    sha: string;
  };
}

interface GitHubTag {
  name: string;
}

interface RequestOptions {
  body?: unknown;
  method?: string;
}

export class GitHub {
  readonly #config: Config;

  constructor(config: Config) {
    this.#config = config;
  }

  async ensureRepository(manifest: ModuleManifest) {
    const existing = await this.#getRepositoryOrUndefined(manifest.name);
    if (existing) {
      return existing;
    }

    return this.#request<GitHubRepository>(`/orgs/${this.#org}/repos`, {
      body: {
        auto_init: true,
        description: manifest.description,
        name: manifest.name,
        private: isPrivateRepository()
      },
      method: 'POST'
    });
  }

  async getRepository(name: string) {
    const repository = await this.#getRepositoryOrUndefined(name);
    if (!repository) {
      throw new ModuleNotFound();
    }

    return repository;
  }

  async versionExists(name: string, version: string) {
    try {
      await this.#request<GitHubRef>(
        `/repos/${this.#org}/${name}/git/ref/tags/${versionToTag(version)}`
      );

      return true;
    } catch (err) {
      if (isStatus(err, 404) || isEmptyRepositoryError(err)) {
        return false;
      }

      throw err;
    }
  }

  async getBranchHead(name: string, branch: string) {
    try {
      const ref = await this.#request<GitHubRef>(
        `/repos/${this.#org}/${name}/git/ref/heads/${branch}`
      );

      return ref.object.sha;
    } catch (err) {
      if (isStatus(err, 404) || isEmptyRepositoryError(err)) {
        return undefined;
      }

      throw err;
    }
  }

  async createTree(name: string, files: PublishingFile[]) {
    const tree = await Promise.all(
      files.map(async (file) => {
        const blob = await this.#request<GitHubBlob>(
          `/repos/${this.#org}/${name}/git/blobs`,
          {
            body: {
              content: Buffer.from(file.content).toString('base64'),
              encoding: 'base64'
            },
            method: 'POST'
          }
        );

        return {
          mode: file.executable ? '100755' : '100644',
          path: file.path,
          sha: blob.sha,
          type: 'blob'
        };
      })
    );

    return this.#request<GitHubTree>(`/repos/${this.#org}/${name}/git/trees`, {
      body: {
        tree
      },
      method: 'POST'
    });
  }

  async createCommit(
    name: string,
    treeSha: string,
    message: string,
    parentSha?: string
  ) {
    const body: Record<string, unknown> = {
      message,
      tree: treeSha
    };

    if (parentSha) {
      body['parents'] = [parentSha];
    }

    return this.#request<GitHubCommit>(
      `/repos/${this.#org}/${name}/git/commits`,
      {
        body,
        method: 'POST'
      }
    );
  }

  async initializeRepository(name: string, branch: string) {
    const result = await this.#request<GitHubContentWriteResult>(
      `/repos/${this.#org}/${name}/contents/.metadata-repository-bootstrap`,
      {
        body: {
          branch,
          content: Buffer.from(
            'Temporary bootstrap file for first metadata repository publish.\n'
          ).toString('base64'),
          message: 'Initialize metadata repository repository'
        },
        method: 'PUT'
      }
    );

    return result.commit.sha;
  }

  async createVersionTag(name: string, version: string, sha: string) {
    return this.#createRef(name, `refs/tags/${versionToTag(version)}`, sha);
  }

  async upsertBranch(
    name: string,
    branch: string,
    sha: string,
    exists: boolean
  ) {
    if (!exists) {
      await this.#createRef(name, `refs/heads/${branch}`, sha);

      return;
    }

    await this.#request<GitHubRef>(
      `/repos/${this.#org}/${name}/git/refs/heads/${branch}`,
      {
        body: {
          force: false,
          sha
        },
        method: 'PATCH'
      }
    );
  }

  async getManifest(name: string, version: string) {
    const content = await this.#request<GitHubContentFile>(
      `/repos/${this.#org}/${name}/contents/module.json?ref=${versionToTag(version)}`
    );

    if (content.encoding !== 'base64') {
      throw new InternalServerError(
        'GitHub returned unsupported content encoding.',
        '/',
        'GitHub Error'
      );
    }

    return JSON.parse(
      Buffer.from(content.content, 'base64').toString('utf8')
    ) as unknown;
  }

  async listVersions(name: string) {
    await this.getRepository(name);

    const tags: GitHubTag[] = [];
    for (let page = 1; ; page += 1) {
      let pageTags: GitHubTag[];
      try {
        pageTags = await this.#request<GitHubTag[]>(
          `/repos/${this.#org}/${name}/tags?per_page=100&page=${page}`
        );
      } catch (err) {
        if (isEmptyRepositoryError(err)) {
          return [];
        }

        throw err;
      }

      tags.push(...pageTags);

      if (pageTags.length < 100) {
        break;
      }
    }

    return tags
      .map((tag) => tagToVersion(tag.name))
      .filter((version): version is string => version !== undefined);
  }

  async listRepositories() {
    const repositories: GitHubRepository[] = [];
    for (let page = 1; ; page += 1) {
      const pageRepositories = await this.#request<GitHubRepository[]>(
        `/orgs/${this.#org}/repos?type=all&per_page=100&page=${page}`
      );

      repositories.push(
        ...pageRepositories.filter((repository) =>
          isModuleRepositoryName(repository.name)
        )
      );

      if (pageRepositories.length < 100) {
        break;
      }
    }

    return repositories;
  }

  async downloadArchive(name: string, version: string) {
    const response = await fetch(this.createArchiveUrl(name, version), {
      headers: this.#headers()
    });

    if (response.status === 404) {
      throw new ArchiveNotFound();
    }

    if (!response.ok || !response.body) {
      throw createGitHubError(response.status, await readGitHubError(response));
    }

    return response.body;
  }

  createArchiveUrl(name: string, version: string) {
    return `${GITHUB_API}/repos/${this.#org}/${name}/tarball/refs/tags/${versionToTag(version)}`;
  }

  getRepositoryOwner(repository: GitHubRepositoryUrl) {
    return repositoryOwner(repository);
  }

  async #getRepositoryOrUndefined(name: string) {
    try {
      return await this.#request<GitHubRepository>(
        `/repos/${this.#org}/${name}`
      );
    } catch (err) {
      if (isStatus(err, 404)) {
        return undefined;
      }

      throw err;
    }
  }

  async #createRef(name: string, ref: string, sha: string) {
    return this.#request<GitHubRef>(`/repos/${this.#org}/${name}/git/refs`, {
      body: {
        ref,
        sha
      },
      method: 'POST'
    });
  }

  async #request<T>(path: string, options: RequestOptions = {}) {
    const request: RequestInit = {
      headers: {
        ...this.#headers(),
        ...(options.body === undefined
          ? {}
          : {
              'content-type': 'application/json'
            })
      },
      method: options.method ?? 'GET'
    };

    if (options.body !== undefined) {
      request.body = JSON.stringify(options.body);
    }

    const response = await fetch(`${GITHUB_API}${path}`, request);

    if (!response.ok) {
      throw createGitHubError(response.status, await readGitHubError(response));
    }

    return (await response.json()) as T;
  }

  #headers() {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.#config.METADATA_REPOSITORY_GITHUB_TOKEN}`,
      'user-agent': 'metadata-repository',
      'x-github-api-version': '2022-11-28'
    };
  }

  get #org() {
    return this.#config.METADATA_REPOSITORY_GITHUB_ORG;
  }
}

function versionToTag(version: string) {
  return `v${version}`;
}

function tagToVersion(tag: string) {
  const version = tag.startsWith('v') ? tag.slice(1) : tag;

  return isSemver(version) ? version : undefined;
}

function repositoryOwner(repository: GitHubRepositoryUrl) {
  const marker = 'github.com/';
  const index = repository.html_url.indexOf(marker);
  if (index === -1) {
    return '';
  }

  const [owner = ''] = repository.html_url
    .slice(index + marker.length)
    .split('/');

  return owner;
}

function mapGitHubStatus(status: number) {
  switch (status) {
    case 401:
    case 403:
    case 404:
    case 409:
      return status;
    case 422:
      return 409;
    default:
      return status >= 400 && status < 500 ? 400 : 500;
  }
}

function createGitHubError(status: number, detail: string) {
  const mapped = mapGitHubStatus(status);

  switch (mapped) {
    case 400:
    case 401:
    case 403:
    case 404:
    case 409:
      return new MetadataError(
        'about:blank',
        mapped,
        'GitHub Error',
        detail,
        '/'
      );
    default:
      return new InternalServerError(detail, 'GitHub Error');
  }
}

async function readGitHubError(response: Response) {
  const body: unknown = await response.json().catch(() => undefined);
  if (
    typeof body === 'object' &&
    body !== null &&
    'message' in body &&
    typeof body.message === 'string'
  ) {
    return body.message;
  }

  return `GitHub request failed with ${response.status}`;
}

function isModuleRepositoryName(name: string) {
  try {
    assertModuleName(name);

    return true;
  } catch {
    return false;
  }
}

function isStatus(err: unknown, status: number) {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    err.status === status
  );
}

function isEmptyRepositoryError(err: unknown) {
  return (
    err instanceof MetadataError &&
    err.status === 409 &&
    err.detail === 'Git Repository is empty.'
  );
}

function isPrivateRepository() {
  const visibility: string = METADATA_REPOSITORY_GITHUB_REPO_VISIBILITY;

  return visibility === 'private';
}
