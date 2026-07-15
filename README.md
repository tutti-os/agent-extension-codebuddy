# CodeBuddy Code Agent Extension for Tutti

Declarative Tutti integration for `@tencent-ai/codebuddy-code@2.121.2` through standard ACP.

## Validate

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:tutti-agent
```

Verify the real ACP runtime without sending a paid prompt:

```sh
python3 scripts/probe_acp_runtime.py --cwd /path/to/project -- codebuddy --acp
```

The signed manifest references the primary Agent identity artwork through `icon` and the home poster through `heroImage`. Tutti projects the icon to Agent selectors, conversation rows, Message Center, and mentions. Keep each packaged image at or below 256 KiB and replace it deliberately when branding changes.

## Release

The repository-owned `.github/workflows/release.yml` builds, signs, and uploads immutable releases using `scripts/release/`. Configure the documented GitHub OIDC/AWS variables and the `TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY` repository secret before dispatch. For new infrastructure, deploy `infra/aws/agent-extension-release-infrastructure.yaml`.
