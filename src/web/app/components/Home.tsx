/*
 * The way in.
 *
 * A CONNECT BUTTON AND NOTHING ELSE. There is no email, no password and no session — the wallet IS
 * the account, and the key never leaves the device (see DECISIONS on on-device signing, no TEE and
 * no delegated MPC). So the page has one action, and the rest of it is the claim that makes the
 * action safe to take.
 *
 * LAID OUT ON THE THEME'S OWN LOGIN PAGE (matsu-theme.vercel.app/login), deliberately rather than
 * approximately: a two-column grid with the form on the left and a full-bleed image on the right,
 * the form column holding a brand row at the top and the form itself centred in the remaining
 * space at `max-w-xs`. What is NOT copied is the email/password form, the "or continue with"
 * divider and the social button — there is nothing to type and no second way in, so a copy of that
 * section would be decoration that implies otherwise.
 *
 * The hero is Suidobashi and lives behind the right column, hidden below `lg` because a half-screen
 * illustration on a phone is a screenful of nothing to do with the task.
 */
import { Button } from '@/components/ui/button';
import { SourceAvatar } from '@/components/Avatar';

export function Home({ ready, note, onConnect }: {
  /** False until the wallet bundle has loaded. The button waits rather than failing. */
  ready: boolean;
  /** A connect failure, or null. */
  note: string | null;
  onConnect: () => void;
}) {
  return (
    <div className="grid h-full lg:grid-cols-2">
      {/* LEFT — the form column. `flex-1` on the middle row is what centres the form in the space
          left over after the brand row, rather than centring it in the column. */}
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <div className="flex items-center gap-3 font-bold font-serif">
            {/* The theme's mark: a small primary tile with a round avatar overhanging it. The
                avatar is deliberately larger than the tile — that overhang is the shape. */}
            <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <SourceAvatar source="wallet" size={32} />
            </div>
            suidobashi
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">
            <div className="flex flex-col gap-6">
              <div className="flex flex-col items-center gap-2 text-center">
                <h1 className="font-serif text-2xl font-bold">Connect your wallet</h1>
                <p className="text-balance text-sm text-muted-foreground">
                  Suidobashi is a DeFi talent marketplace on Sui. A local agent captures your
                  intent and verifies every transaction against the protocols you've installed.
                </p>
              </div>

              {note && (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                  {note}
                </p>
              )}

              <Button className="w-full" onClick={onConnect} disabled={!ready}>
                {ready ? 'connect wallet' : 'loading wallet…'}
              </Button>

              {/* WHAT THE BUTTON DOES, where the theme puts "don't have an account?". The failure
                  mode is said out loud too: if the bridge never loaded, the button is dead and this
                  is the only thing on the page that explains why. */}
              <p className="text-center text-sm text-muted-foreground">
                {ready
                  ? 'signing happens in the wallet, one transaction at a time'
                  : 'the wallet bundle has not loaded — check the server log'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT — the hero. `bg-muted` underneath so the column reads as a surface while the image
          loads, and `object-cover` so any viewport proportion is filled rather than letterboxed. */}
      <div className="relative hidden bg-muted lg:block">
        <img
          src="/suidobashi.jpg"
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>
    </div>
  );
}
