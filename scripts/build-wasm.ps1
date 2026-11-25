# Builds clearpixel-core Rust crate into packages/clearpixel-web/public/wasm/
# Requires: rustup + wasm-pack (cargo install wasm-pack)

$ErrorActionPreference = "Stop"

Write-Host "Running Rust unit tests..." -ForegroundColor Cyan
cargo test --manifest-path packages/clearpixel-core/Cargo.toml

Write-Host "Building Rust WASM (SIMD128 + LTO)..." -ForegroundColor Cyan
$env:RUSTFLAGS = "-C target-feature=+simd128"
wasm-pack build packages/clearpixel-core `
  --target web `
  --release `
  --out-dir ../clearpixel-web/public/wasm `
  --out-name clearpixel_core

Write-Host "Done! WASM binary ready at packages/clearpixel-web/public/wasm/" -ForegroundColor Green
