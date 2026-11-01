/** The narrow Promise-based V2 hook contract; no runtime SDK dependency. */
interface Context {
  options: Record<string, unknown>;
  session: {
    hook(name: "http.request", handler: (event: { request: Request }) => void): Promise<{ dispose(): Promise<void> }>;
  };
}

const inference = /(?:\/(?:responses|chat\/completions|messages)|:(?:streamGenerateContent|generateContent))\/?$/;

export default {
  id: "jev-gateway",
  async setup(ctx: Context) {
    const unmatched = ctx.options.unmatched ?? "passthrough";
    if (unmatched !== "passthrough" && unmatched !== "reject")
      throw new Error("Jev unmatched must be passthrough or reject");
    const entries = ctx.options.routes === undefined ? {} : ctx.options.routes;
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
      throw new Error("Jev routes must be an endpoint map");
    const routes = new Map<string, string>();
    for (const [source, destination] of Object.entries(entries)) {
      const from = new URL(source);
      if (!["http:", "https:"].includes(from.protocol) || from.username || from.password || from.search || from.hash) {
        throw new Error("Jev route sources must be HTTP endpoints without credentials, query or fragment");
      }
      if (typeof destination !== "string") throw new Error("Jev route destinations must be URLs");
      const to = new URL(destination);
      if (
        !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+(?:\/|$)/.test(destination) ||
        to.username ||
        to.password ||
        to.search ||
        to.hash
      ) {
        throw new Error(
          "Jev must use a loopback HTTP gateway with an explicit port and no credentials, query or fragment",
        );
      }
      routes.set(`${from.origin}${from.pathname}`, to.href);
    }
    // Register after authentication plugins. The final Request already has
    // provider authentication; changing only its URL retains body/abort state.
    const registration = await ctx.session.hook("http.request", (event) => {
      if (event.request.method !== "POST") return;
      const url = new URL(event.request.url);
      const destination = routes.get(`${url.origin}${url.pathname}`);
      if (!destination) {
        if (unmatched === "reject" && inference.test(url.pathname))
          throw new Error("Jev route missing for an inference endpoint");
        return;
      }
      const target = new URL(destination);
      target.search = url.search;
      event.request = new Request(target, event.request);
    });
    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      await registration.dispose();
    };
  },
};
