export interface AiVideoScriptTemplate {
  id: string;
  title: string;
  genre: string;
  setting: string;
  characters: string;
  motions: string;
  stageDirections: [string, string, string, string];
  lighting: string;
  filter: string;
  camera: string;
}

/** Eight-second, four-beat scripts derived from pawscripts.md plus new sets. */
export const AI_VIDEO_SCRIPTS: AiVideoScriptTemplate[] = [
  {
    id: "superhero-pup",
    title: "Cape-Flapping Superhero Pup",
    genre: "heroic comedy",
    setting: "A rooftop above a bright, stylized city at sunrise",
    characters: "One heroic dog wearing a small red cape; preserve the pet's exact face, markings, coat, and proportions",
    motions: "Ears lift, head turns toward the skyline, cape flaps, then the dog plants both front paws in a proud hero pose",
    stageDirections: ["0-2s: close on the pet as the ears lift and eyes focus", "2-4s: head turns toward the skyline while the cape catches wind", "4-6s: camera arcs low as the pet steps forward", "6-8s: hold a proud hero pose with one final cape flutter"],
    lighting: "Warm sunrise key light, cool city fill, crisp golden rim light on fur",
    filter: "Polished family-film color, rich reds and blues, subtle cinematic bloom",
    camera: "Low-angle 35mm push-in with one smooth hero arc; no cuts that change identity",
  },
  {
    id: "lofi-window-cat",
    title: "Lofi Rainy Window Cat",
    genre: "calm lofi",
    setting: "A cozy reading nook beside a rain-streaked window at night",
    characters: "One relaxed cat on a cushion; preserve face, coat pattern, eye color, and body shape",
    motions: "Slow blink, ear twitch, small head turn toward rain, tail tip curls once",
    stageDirections: ["0-2s: rain reflections drift across the cat's fur", "2-4s: cat slow-blinks and one ear turns toward a drop", "4-6s: gentle head turn toward the window", "6-8s: tail tip curls and the cat settles into stillness"],
    lighting: "Soft amber lamp key, cool blue rain fill, wet-window reflections",
    filter: "Lofi film grain, muted teal and amber, soft halation",
    camera: "Locked medium close-up with a very slow dolly inward",
  },
  {
    id: "midnight-treat-heist",
    title: "Midnight Treat Heist",
    genre: "playful caper",
    setting: "A moonlit kitchen with a treat jar on a low counter",
    characters: "One sneaky pet and a treat jar; preserve the pet's appearance exactly",
    motions: "Crouch, tiptoe, glance left and right, stretch toward the jar, freeze when a light flicks on",
    stageDirections: ["0-2s: pet peeks around the doorway", "2-4s: exaggerated quiet tiptoe toward the counter", "4-6s: paw reaches for the jar as the lid rattles", "6-8s: light turns on and the pet freezes with an innocent look"],
    lighting: "Cool moonlight shafts with a warm refrigerator glow",
    filter: "High-contrast caper look, gentle vignette, clean fur detail",
    camera: "Ground-level tracking shot, quick rack focus to the treat jar, comic final hold",
  },
  {
    id: "golden-park-sprint",
    title: "Golden Hour Park Sprint",
    genre: "uplifting sports portrait",
    setting: "An open park path through tall grass at golden hour",
    characters: "One joyful pet running freely; exact identity and markings must remain stable",
    motions: "Powerful sprint, ears and fur move naturally, head turns briefly toward camera, then a joyful leap",
    stageDirections: ["0-2s: pet launches into a sprint", "2-4s: side tracking shot shows natural gait and fur motion", "4-6s: pet glances toward camera while running", "6-8s: small joyful leap into a sunlit finish"],
    lighting: "Low golden sun, luminous rim light, soft natural shadows",
    filter: "Warm cinematic Kodak-inspired color, restrained lens flare",
    camera: "Low stabilized side-track, then a slight slow-motion push for the final leap",
  },
  {
    id: "wizard-kitten",
    title: "Magical Wizard Kitten",
    genre: "whimsical fantasy",
    setting: "A miniature candlelit library with floating spell pages",
    characters: "One kitten in a tiny wizard hat; preserve the kitten's face, fur, and eye color",
    motions: "Paw taps an open book, ears lift, glowing motes spiral upward, kitten turns its head in wonder",
    stageDirections: ["0-2s: kitten studies the open book", "2-4s: one paw taps the page and runes begin glowing", "4-6s: pages and motes rise in a gentle spiral", "6-8s: kitten looks up as one harmless spark becomes a tiny paw shape"],
    lighting: "Warm candle key, violet magical fill, soft gold edge light",
    filter: "Storybook fantasy, jewel tones, controlled bloom and fine grain",
    camera: "Slow tabletop orbit ending in a close-up on the kitten's reaction",
  },
  {
    id: "victorian-cat",
    title: "Victorian Portrait Cat",
    genre: "historical portrait comedy",
    setting: "A richly furnished 1890s portrait studio with velvet drapes and carved wood",
    characters: "One cat dressed as a dignified pre-1900 statesperson; identity and coat pattern unchanged",
    motions: "Chin lifts, head turns three-quarters, one paw settles on a tiny book, dignified slow blink",
    stageDirections: ["0-2s: reveal the formal portrait pose", "2-4s: cat lifts chin and turns toward key light", "4-6s: paw settles on the book as dust motes drift", "6-8s: dignified slow blink and subtle portrait flash"],
    lighting: "Large north-window key, warm candle practicals, painterly edge light",
    filter: "Pre-1900 oil-portrait palette with modern photoreal fur and restrained sepia",
    camera: "Slow formal push-in, symmetrical composition, no modern objects",
  },
  {
    id: "royal-court-dog",
    title: "Royal Court Dog",
    genre: "historical royal pageant",
    setting: "An ornate eighteenth-century palace gallery",
    characters: "One dog as a benevolent royal figure in a fitted brocade coat; preserve anatomy and identity",
    motions: "Head turns, ears lift beneath the costume, one measured step forward, tail gives one proud wag",
    stageDirections: ["0-2s: establish the palace and royal silhouette", "2-4s: dog turns toward camera", "4-6s: one stately step as the brocade catches light", "6-8s: proud tail wag and gentle bow"],
    lighting: "Chandelier warmth, soft window fill, gold rim on the coat and fur",
    filter: "Lush period-drama grade, clean skin and fur detail, subtle film grain",
    camera: "Centered dolly-in with a small parallax move past foreground candelabra",
  },
  {
    id: "memorial-sunrise",
    title: "Memorial Sunrise",
    genre: "tender remembrance",
    setting: "A quiet meadow at sunrise with soft wildflowers and a distant rainbow haze",
    characters: "One beloved pet, healthy and peaceful, with exact face, coat markings, and familiar expression",
    motions: "Ears lift, head turns toward a warm breeze, fur catches light, pet looks calmly into camera",
    stageDirections: ["0-2s: sunrise reveals the pet resting in flowers", "2-4s: ears lift as a breeze moves the fur", "4-6s: pet turns gently toward camera", "6-8s: hold a peaceful familiar expression as light blooms softly"],
    lighting: "Soft sunrise key, delicate backlight, natural pastel sky fill",
    filter: "Respectful cinematic warmth, soft highlight bloom, no fantasy wings or altered anatomy",
    camera: "Slow eye-level push-in with a steady final portrait hold",
  },
];

export const DEFAULT_AI_VIDEO_SCRIPT = AI_VIDEO_SCRIPTS[0];
