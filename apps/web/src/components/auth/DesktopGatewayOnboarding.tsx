import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { useState } from "react";

import { connectPairing } from "../../connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AuthSurfaceShell } from "./AuthSurfaceShell";

export function DesktopGatewayOnboarding() {
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    const result = await connect({ pairingUrl: pairingUrl.trim() });
    if (AsyncResult.isFailure(result)) {
      const cause = Cause.squash(result.cause);
      setError(cause instanceof Error ? cause.message : "Could not pair with this gateway.");
      setSubmitting(false);
    }
  };

  return (
    <AuthSurfaceShell>
      <h1 className="text-2xl font-semibold tracking-tight">Connect Cocoa Desktop</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Paste a pairing string from Cocoa Web → Settings → Clients. This app exchanges it once and
        stores its own device session securely.
      </p>
      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          nativeInput
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={submitting}
          aria-label="Cocoa pairing string"
          placeholder="https://cocoa.example.com/pair#token=…"
          value={pairingUrl}
          onChange={(event) => setPairingUrl(event.currentTarget.value)}
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" disabled={submitting || pairingUrl.trim().length === 0}>
          {submitting ? "Connecting…" : "Connect"}
        </Button>
      </form>
    </AuthSurfaceShell>
  );
}
