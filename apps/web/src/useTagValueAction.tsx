import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { runTagValueAction } from "./tagValueAction";
import type { TagActionIdentity, TagActionReview } from "./tagValueAction";

/** One action per owner; changing screens, publication or access cancels pending confirmation. */
export function useTagValueAction(identity: string, available: boolean) {
  const [review, setReview] = useState<TagActionReview | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const owner = useRef({ identity, available }); owner.current = { identity, available };
  const running = useRef<AbortController | null>(null);
  const answer = useRef<((confirmed: boolean) => void) | null>(null);
  const settle = (confirmed: boolean) => { answer.current?.(confirmed); answer.current = null; setReview(null); };
  useEffect(() => {
    return () => { running.current?.abort(); answer.current?.(false); answer.current = null; };
  }, [identity, available]);
  useEffect(() => {
    if (!review) { dialog.current?.close(); return; }
    dialog.current?.showModal();
    const timeout = setTimeout(() => settle(false), Math.max(0, Date.parse(review.expiresAt) - Date.now()));
    return () => { clearTimeout(timeout); dialog.current?.close(); };
  }, [review]);

  async function run(route: string, request: TagActionIdentity, isCurrent: () => boolean) {
    if (!available || running.current) throw new Error("This tag action is unavailable or already running.");
    const captured = identity, controller = new AbortController(); running.current = controller;
    try {
      return await runTagValueAction(api, route, request, { signal: controller.signal,
        isCurrent: () => owner.current.available && owner.current.identity === captured && isCurrent(),
        confirm: next => new Promise<boolean>(resolve => {
          const abort = () => settle(false);
          answer.current = value => { controller.signal.removeEventListener("abort", abort); resolve(value); };
          controller.signal.addEventListener("abort", abort, { once: true });
          setReview(next);
        }),
      });
    } finally { if (running.current === controller) running.current = null; settle(false); }
  }
  const confirmation = review && <dialog ref={dialog} className="project-dialog command-confirmation" aria-labelledby="tag-action-confirm-title"
    onCancel={event => { event.preventDefault(); settle(false); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id="tag-action-confirm-title">{review.name}</h2></header>
    <div className="project-dialog-body"><p>{review.confirmation}</p><dl><dt>Current value</dt><dd>{String(review.currentValue)}</dd><dt>Set to</dt><dd>{String(review.requestedValue)}</dd></dl></div>
    <footer><button className="button" autoFocus onClick={() => settle(false)}>Cancel</button><button className="button primary" onClick={() => settle(true)}>Set tag value</button></footer>
  </dialog>;
  return { run, confirmation };
}
