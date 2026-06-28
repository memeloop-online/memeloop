# memeloop-cli

Command-line compute node for the MemeLoop network.

## What is this package?

`memeloop-cli` turns any machine into a MemeLoop compute node. It can:

- Register itself with a MemeLoop relay/cloud directory.
- Run agent loops locally using the `memeloop` core runtime.
- Expose status and logs over RPC.
- Run headless browser tasks and MCP tools.

## Install

```bash
pnpm add -g memeloop-cli
# or
npm install -g memeloop-cli
```

## Usage

```bash
# Start the CLI node
memeloop start

# Register with a cloud relay
memeloop register --relay https://relay.example.com

# Check node status
memeloop status
```

## Configuration

The CLI reads YAML configuration files (e.g. `memeloop-cli.yaml`) for node identity, relay endpoints, and profile selection.

## Development

```bash
pnpm install
pnpm --filter memeloop-cli build
pnpm --filter memeloop-cli test
```

## License

MIT
