"use client";

import { useRef, useState } from "react";
import { PhonePortal } from "@/frontend/components/phone-portal";

/**
 * "Take a photo, or pick one you already have."
 *
 * `accept="image/*"` alone already lets both platforms offer camera AND gallery,
 * but only behind a native menu the operator has to know is there — which is why
 * these buttons were read as camera-only. This makes the choice explicit and
 * routes each branch to the input that guarantees it:
 *
 *   • Take Photo    → `capture="environment"`, which opens the rear camera directly.
 *   • From Gallery  → no `capture`, so the picker opens on Photos / Files.
 *
 * The caller keeps its own upload logic untouched — this hands back a File and
 * nothing else.
 */
export function usePhotoSource(onFile: (file: File) => void, opts?: { title?: string }) {
  const camRef = useRef<HTMLInputElement>(null);
  const galRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);

  const take = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    // Cleared so picking the SAME file twice still fires a change event.
    e.target.value = "";
    if (f) onFile(f);
  };

  const node = (
    <>
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={take} />
      <input ref={galRef} type="file" accept="image/*" hidden onChange={take} />
      {open && (
        <PhonePortal>
          <div className="sheetWrap" onClick={() => setOpen(false)}>
            <div className="sheet compact" onClick={(e) => e.stopPropagation()}>
              <div className="sheetTitle">{opts?.title ?? "Add photo"}</div>
              <div className="sheetStep">Use the camera, or choose a file you already have</div>
              <button
                className="cta"
                onClick={() => {
                  setOpen(false);
                  camRef.current?.click();
                }}
              >
                📷 TAKE PHOTO
              </button>
              <button
                className="cta ghost"
                onClick={() => {
                  setOpen(false);
                  galRef.current?.click();
                }}
              >
                🖼 CHOOSE FROM GALLERY / FILES
              </button>
              <button className="cta ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </PhonePortal>
      )}
    </>
  );

  return { pick: () => setOpen(true), node };
}
