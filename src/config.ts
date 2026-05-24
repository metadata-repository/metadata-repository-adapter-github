import { InvalidAdapterConfig } from '#modules/metadata-repository-adapter/src/errors/invalid-adapter-config.js';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const Config = Type.Object({
  METADATA_REPOSITORY_GITHUB_ORG: Type.String(),
  METADATA_REPOSITORY_GITHUB_TOKEN: Type.String()
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig() {
  try {
    return Value.Parse(Config, process.env);
  } catch {
    throw new InvalidAdapterConfig();
  }
}
