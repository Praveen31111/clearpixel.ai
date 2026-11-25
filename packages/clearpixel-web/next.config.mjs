/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  webpack: (config, { webpack }) => {
    // Exclude Node-only dependencies & >25MiB ORT WASM binaries from static bundle
    // (loaded cleanly from jsDelivr CDN at runtime so Cloudflare 25MiB asset limit is never hit)
    config.resolve.alias = {
      ...config.resolve.alias,
      sharp$: false,
      'onnxruntime-node$': false,
    };
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /ort-wasm.*\.wasm$/,
      })
    );
    return config;
  },
};

export default nextConfig;
