import * as NodeServices from "@effect/platform-node/NodeServices";
import { OpenCodeSettings, ProviderHostConfig, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../Layers/ProviderEventLoggersService.ts";
import { makeOpenCodeEndpointDriver } from "./OpenCodeEndpointDriver.ts";

const missingServerUrlConfig = Schema.decodeSync(OpenCodeSettings)({});
const resolvedHost = Schema.decodeSync(ProviderHostConfig)({
  transport: {
    type: "cocoa-host",
    url: "wss://host.example.test:4500",
    key: "host_key",
  },
});

const TestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "cocoa-opencode-endpoint-driver-test",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.succeed(
      BackgroundPolicy.BackgroundPolicy,
      {} as BackgroundPolicy.BackgroundPolicy["Service"],
    ),
  ),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

it.layer(TestLayer)("OpenCodeEndpointDriver", (it) => {
  it.effect("keeps serverUrl mandatory even when an execution host is resolved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const error = yield* makeOpenCodeEndpointDriver()
          .create({
            instanceId: ProviderInstanceId.make("remote_opencode"),
            host: resolvedHost,
            displayName: "Remote OpenCode",
            accentColor: undefined,
            environment: [],
            enabled: true,
            config: missingServerUrlConfig,
          })
          .pipe(Effect.flip);

        assert.strictEqual(error._tag, "ProviderDriverError");
        assert.match(error.detail, /require an explicit server URL/i);
      }),
    ),
  );
});
