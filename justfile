default:
    @just --list

# Run the client app in dev mode
dev:
    cd client && just dev

# Build the client
build:
    cd client && just build

# Lint everything (TS + Rust)
lint:
    cd client && just lint

# Typecheck + cargo check
check:
    cd client && just check

# Format everything
fmt:
    cd client && just fmt

# Run tests
test:
    cd client && just test
