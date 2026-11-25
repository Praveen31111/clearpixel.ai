export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Same-origin proxy for Hugging Face model weights & configs (eliminates CORS issues)
    if (url.pathname.startsWith('/hf/')) {
      const targetUrl = 'https://huggingface.co/' + url.pathname.slice(4) + url.search;
      const upstream = await fetch(targetUrl, {
        method: request.method,
        headers: {
          'User-Agent': 'ClearPixel-AI/1.0',
        },
        redirect: 'follow',
      });

      const headers = new Headers(upstream.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'public, max-age=86400');

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }

    // Serve static Next.js export for all other routes
    return env.ASSETS.fetch(request);
  },
};
