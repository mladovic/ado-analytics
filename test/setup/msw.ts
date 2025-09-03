import { afterAll, afterEach, beforeAll } from "vitest";
import { setupServer } from "msw/node";

const server = setupServer(/* ...adoHandlers */);

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

export { server };
