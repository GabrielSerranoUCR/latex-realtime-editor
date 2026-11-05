/** Who a scribe appears as to others (name flag + cursor colour); derived from their account. */
export interface CollabUser {
  /** The account behind the cursor (stamped by the server; absent on a scribe's own, not-yet-stamped state). */
  id?: string;
  name: string;
  color: string;
  colorLight: string;
}
