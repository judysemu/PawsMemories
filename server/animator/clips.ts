// Do not advertise clips until their reviewed, licensed GLB files are shipped.
// Animator still exposes animations embedded in each customer's owned model.
export const CC0_CLIPS: Array<{
  id: string;
  name: string;
  skeleton: string;
  url: string;
  author: string;
  description: string;
}> = [];
