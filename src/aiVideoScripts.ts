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
    stageDirections: ["close on the pet as the ears lift and eyes focus", "head turns toward the skyline while the cape catches wind", "camera arcs low as the pet steps forward", "hold a proud hero pose with one final cape flutter"],
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
    motions: "Slow blink, ear twitch, small head turn toward rain, tail tip curling, chest rising and falling with steady breathing, fur rippling in the draft while rain shadows crawl across the coat",
    stageDirections: ["rain reflections drift across the cat's fur", "the cat slow-blinks and one ear turns toward a running drop", "a gentle head turn follows the water down the glass", "the tail tip curls and the cat settles, still breathing, as the rain keeps moving"],
    lighting: "Soft amber lamp key, cool blue rain fill, wet-window reflections",
    filter: "Lofi film grain, muted teal and amber, soft halation",
    camera: "Intimate medium close-up on a very slow, continuous dolly inward",
  },
  {
    id: "midnight-treat-heist",
    title: "Midnight Treat Heist",
    genre: "playful caper",
    setting: "A moonlit kitchen with a treat jar on a low counter",
    characters: "One sneaky pet and a treat jar; preserve the pet's appearance exactly",
    motions: "Crouch, tiptoe, glance left and right, stretch toward the jar, freeze when a light flicks on",
    stageDirections: ["pet peeks around the doorway", "exaggerated quiet tiptoe toward the counter", "paw reaches for the jar as the lid rattles", "light turns on and the pet freezes with an innocent look"],
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
    stageDirections: ["pet launches into a sprint", "side tracking shot shows natural gait and fur motion", "pet glances toward camera while running", "small joyful leap into a sunlit finish"],
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
    stageDirections: ["kitten studies the open book", "one paw taps the page and runes begin glowing", "pages and motes rise in a gentle spiral", "kitten looks up as one harmless spark becomes a tiny paw shape"],
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
    motions: "Chin lifts, head turns three-quarters, one paw settles on a tiny book, dignified slow blink, whiskers and ruff stirring as dust motes drift through the key light",
    stageDirections: ["reveal the formal portrait pose", "cat lifts chin and turns toward key light", "paw settles on the book as dust motes drift", "dignified slow blink and subtle portrait flash"],
    lighting: "Large north-window key, warm candle practicals, painterly edge light",
    filter: "Pre-1900 oil-portrait palette with modern photoreal fur and restrained sepia",
    camera: "Slow formal push-in on a symmetrical composition, drifting gently throughout; no modern objects",
  },
  {
    id: "royal-court-dog",
    title: "Royal Court Dog",
    genre: "historical royal pageant",
    setting: "An ornate eighteenth-century palace gallery",
    characters: "One dog as a benevolent royal figure in a fitted brocade coat; preserve anatomy and identity",
    motions: "Head turns, ears lift beneath the costume, one measured step forward, tail gives one proud wag",
    stageDirections: ["establish the palace and royal silhouette", "dog turns toward camera", "one stately step as the brocade catches light", "proud tail wag and gentle bow"],
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
    stageDirections: ["sunrise reveals the pet resting in flowers", "ears lift as a breeze moves the fur and the wildflowers sway", "the pet turns gently toward camera", "hold a peaceful familiar expression while the breeze, fur, and blooming light keep moving"],
    lighting: "Soft sunrise key, delicate backlight, natural pastel sky fill",
    filter: "Respectful cinematic warmth, soft highlight bloom, no fantasy wings or altered anatomy",
    camera: "Slow eye-level push-in easing into a gentle final drift rather than a full stop",
  },
  {
    id: "moonlight-maestro",
    title: "Moonlight Maestro",
    genre: "elegant musical fantasy",
    setting: "A candlelit chamber music room beneath tall windows filled with blue moonlight",
    characters: "One pet composer beside an original miniature piano; preserve the pet's exact face, coat, eye color, and proportions",
    motions: "The pet raises one paw, turns toward the keys, taps a single note, then looks proudly toward camera as sheet music stirs",
    stageDirections: ["moonlight reveals the pet seated beside the piano", "one paw rises while the ears focus on the music", "paw taps one key and sheet music lifts gently", "pet turns to camera and holds a proud final portrait"],
    lighting: "Soft blue moon fill, warm candle key, and a narrow silver rim defining individual fur strands",
    filter: "Polished period-film color with midnight blue, warm ivory, restrained bloom, and fine grain",
    camera: "One slow 35mm semicircle from the music stand to an eye-level portrait; no cuts",
  },
  {
    id: "joans-banner",
    title: "Joan's Banner",
    genre: "hopeful historical adventure",
    setting: "A misty stone courtyard at dawn with an original unmarked banner moving in a light breeze",
    characters: "One brave pet in lightweight original ceremonial armor; preserve identity and keep the costume clear of the face and ears",
    motions: "The pet lifts its head, takes one steady step, watches the banner rise, then faces the morning light",
    stageDirections: ["reveal the pet in drifting dawn mist beside the lowered banner", "ears lift and the pet takes one measured step", "the unmarked banner rises smoothly behind the pet", "the camera eases to a settle as the pet faces the light, banner and mist still moving"],
    lighting: "Cool dawn ambience, warm sunrise edge light, soft reflections across the original armor",
    filter: "Respectful period-adventure grade with natural stone, muted steel, and warm gold highlights",
    camera: "Low eye-level push forward with one gentle crane rise, easing to a slow settle on the pet",
  },
  {
    id: "santas-workshop-surprise",
    title: "Santa's Workshop Surprise",
    genre: "warm holiday comedy",
    setting: "An original toy workshop filled with wooden gifts, paper stars, and softly falling snow beyond the windows",
    characters: "One cheerful pet in a simple red winter coat with no copied marks; preserve the pet's face, coat, and anatomy",
    motions: "The pet hears a bell, turns toward a small gift box, nudges it open, then reacts to a tiny burst of paper stars",
    stageDirections: ["pet rests beside wrapped gifts as one bell rings", "ears lift and head turns toward a moving box", "pet nudges the lid open with one paw", "paper stars rise and the pet gives one delighted head tilt"],
    lighting: "Warm fireplace key, soft workshop practicals, cool snowy window fill, and gentle fur rim light",
    filter: "Premium family-holiday color, rich red and pine accents, clean highlights, and restrained sparkle",
    camera: "Stable waist-high dolly from the gift stack to the pet's reaction with one soft focus pull",
  },
  {
    id: "cleopatras-golden-entrance",
    title: "Cleopatra's Golden Entrance",
    genre: "regal historical pageant",
    setting: "An original sunlit palace hall with carved columns, linen curtains, and a shallow reflecting pool",
    characters: "One regal pet wearing an original broad jeweled collar that leaves the face unobstructed; preserve exact identity",
    motions: "The pet steps through moving curtains, pauses beside the pool, turns toward camera, then settles into a calm royal pose",
    stageDirections: ["linen curtains part to reveal the pet", "the pet takes two slow steps as the collar catches light", "a reflection appears in the pool as the pet turns toward camera", "hold a calm royal pose while the curtains and pool reflections keep drifting"],
    lighting: "Strong warm sun shafts, soft reflected pool fill, and controlled golden edge light on the coat",
    filter: "Luxurious gold, lapis, and linen palette with photoreal fur and restrained cinematic haze",
    camera: "Centered 50mm backward glide matching the pet's steps, easing into a symmetrical portrait framing",
  },
  {
    id: "rock-star-encore",
    title: "Rock Star Encore",
    genre: "joyful concert finale",
    setting: "An original small arena stage with abstract paw-shaped lights, light haze, and no logos or readable signage",
    characters: "One charismatic pet beside a safely placed miniature microphone; preserve the pet's face, markings, anatomy, and proportions",
    motions: "The pet looks toward the crowd, taps one paw to the beat, turns into a colored light, then finishes with a proud head lift",
    stageDirections: ["stage lights rise behind the pet's silhouette", "pet turns toward the crowd and taps one paw", "camera arcs as colored light crosses the fur", "pet lifts its head for a still encore pose as lights fade"],
    lighting: "Magenta and cyan stage wash, warm face key, white rim light, and controlled haze without strobing",
    filter: "Clean concert-film contrast with saturated accents, detailed fur, and no flicker or rapid effects",
    camera: "One smooth stabilized 28mm arc ending in a medium close-up; no rapid cuts or shaky movement",
  },
  {
    id: "halloween-possessed-toy",
    title: "The Possessed Toy",
    genre: "halloween horror",
    setting: "A long, dimly lit Victorian hallway with peeling wallpaper and scratched wooden floorboards",
    characters: "A fluffy, small pet and a worn, vintage porcelain doll with cracked paint; preserve the pet's exact face, markings, coat, and proportions",
    motions: "Cautious sniffing, sudden backing away, unnatural mechanical twitching of the doll",
    stageDirections: [
      "the pet slowly approaches the porcelain doll lying face-down on the floor",
      "the pet tentatively nudges the doll with its nose",
      "the doll's head slowly rotates 180 degrees on its own to face the pet",
      "the pet scrambles backward, disappearing into the shadows of the hallway",
    ],
    lighting: "Flickering overhead tungsten light, creating heavy, moving shadows in the corners of the hall",
    filter: "Desaturated, sepia-toned, high contrast, heavy vintage film grain overlay",
    camera: "Low angle, tracking backward slowly, maintaining a shallow depth of field that keeps focus entirely on the doll in the foreground",
  },
  {
    id: "halloween-shadow-in-woods",
    title: "The Shadow in the Woods",
    genre: "halloween horror",
    setting: "A dense, foggy forest clearing at midnight, surrounded by dead, twisting, leafless trees",
    characters: "A sleek, dark-furred pet and an unseen, towering shadow figure; preserve the pet's exact appearance",
    motions: "Rigid posture, hair standing on end, frozen in fear, creeping shadow movement",
    stageDirections: [
      "the pet stands completely frozen in the center of the clearing",
      "thick, unnatural fog rolls rapidly over its paws",
      "the pet slowly looks up into the dark tree line",
      "a massive, elongated shadow stretches across the fog, reaching out toward the pet",
    ],
    lighting: "Harsh, cold moonlight cutting through the fog from above, creating backlit silhouettes",
    filter: "Monochromatic blue hues, cinematic teal, misty diffusion filter to make the light bleed",
    camera: "Wide establishing shot, slow push-in zoom leading to an extreme close-up of the pet's wide, reflecting eyes",
  },
  {
    id: "halloween-alchemists-table",
    title: "The Alchemist's Table",
    genre: "halloween horror",
    setting: "A cluttered, dusty medieval study covered in bubbling glass vials, scattered bones, and ancient, open tomes",
    characters: "A majestic, long-haired pet; preserve the pet's exact face, coat, and proportions",
    motions: "Slow, deliberate head turning, unnatural glowing of eyes, swirling mist",
    stageDirections: [
      "the pet sits perfectly still on the wooden table amidst the alchemical clutter",
      "a thick green mist begins to bubble and rise from a nearby glass vial",
      "the pet slowly turns its head to look directly into the camera lens",
      "the pet's eyes suddenly flash and illuminate with a vibrant, unnatural glowing light",
    ],
    lighting: "Underlit by glowing green and purple liquids from the vials, casting grotesque, elongated shadows on the walls behind it",
    filter: "High saturation of toxic greens and deep purples, heavy dark vignette, slight chromatic aberration on the edges of the frame",
    camera: "Static medium shot, slowly rotating around the table in a 30-degree arc to create a creeping parallax effect",
  },
  {
    id: "halloween-mirrors-secret",
    title: "The Mirror's Secret",
    genre: "halloween horror",
    setting: "An abandoned attic draped in heavy cobwebs, featuring a large, ornate, cracked antique vanity mirror leaning against a wall",
    characters: "A curious, small pet; preserve the pet's exact face, markings, and proportions",
    motions: "Playful tilting of the head, contrasting with a menacing, perfectly still reflection",
    stageDirections: [
      "the pet walks up to the mirror and stares at its own reflection",
      "the pet playfully tilts its head to the right",
      "the reflection in the mirror does not mimic the motion; it remains perfectly still, staring dead ahead",
      "the reflection's mouth opens in a silent, unnatural scream as the mirror's glass slowly begins to crack further",
    ],
    lighting: "A single, sharp beam of dusty moonlight coming from a small unseen attic window, illuminating only the mirror and the pet",
    filter: "Cold grayscale with muted silver tones, soft focus with high sharpness strictly on the cracked glass, flickering old film scratch overlay",
    camera: "Over-the-shoulder shot from right behind the pet, focusing entirely on the mirror reflection, with a very slow, creeping dolly-in",
  },
];

export const DEFAULT_AI_VIDEO_SCRIPT = AI_VIDEO_SCRIPTS[0];

// ─── Video Studio v2 teaching layer ─────────────────────────────────────────
// The same idea as the PawPrints teaching panel, applied to video. The sections
// below are not an invented taxonomy: they are literally the fields of
// AiVideoScriptTemplate, so explaining them explains the form the customer is
// already filling in.

export interface VideoPromptSection {
  /** Matches a field name on AiVideoScriptTemplate. */
  id: "setting" | "characters" | "motions" | "stageDirections" | "lighting" | "filter" | "camera";
  label: string;
  text: string;
  /** Plain-language reason this section earns its place. No film-school jargon. */
  explanation: string;
}

export interface AnnotatedVideoSample {
  id: string;
  title: string;
  durationSeconds: 8 | 15;
  sections: VideoPromptSection[];
}

/** Sample 1 for the 8-second tier — dissected section by section. */
export const ANNOTATED_VIDEO_SAMPLE_8S: AnnotatedVideoSample = {
  id: "hero-pup-8s",
  title: "Cape-flapping hero pup",
  durationSeconds: 8,
  sections: [
    { id: "setting", label: "Setting", text: "A rooftop above a bright city at sunrise",
      explanation: "One clear place and time of day. This anchors the whole shot." },
    { id: "characters", label: "Characters", text: "Your dog in a small red cape, exact face and markings kept",
      explanation: "Always ask to keep the pet's real markings and proportions, or the model drifts." },
    { id: "motions", label: "Motion", text: "Ears lift, head turns, cape catches the wind, then a proud pose",
      explanation: "Small physical movements read best. Eight seconds is not long enough for a plot." },
    { id: "stageDirections", label: "Four beats", text: "close-up → head turn → low camera arc → hold the pose",
      explanation: "Four beats is about two seconds each. The model paces them for you." },
    { id: "lighting", label: "Lighting", text: "Warm sunrise key light, cool city fill, golden rim on the fur",
      explanation: "Where the light comes from and what colour it is." },
    { id: "filter", label: "Filter", text: "Polished family-film colour with a subtle cinematic bloom",
      explanation: "The overall look. Two adjectives beat ten." },
    { id: "camera", label: "Camera", text: "Low-angle 35mm push-in, one smooth move, no cuts",
      explanation: "Saying 'no cuts' keeps your pet's face consistent all the way through." },
  ],
};

/** Sample 1 for the 15-second tier. Same sections; the extra time buys a
 *  second location and a longer camera move rather than more cuts. */
export const ANNOTATED_VIDEO_SAMPLE_15S: AnnotatedVideoSample = {
  id: "seaside-stroll-15s",
  title: "Seaside stroll at golden hour",
  durationSeconds: 15,
  sections: [
    { id: "setting", label: "Setting", text: "A quiet beach at golden hour, moving from the dunes down to the water",
      explanation: "Fifteen seconds affords a journey between two places. Eight does not." },
    { id: "characters", label: "Characters", text: "Your cat carried in a tote bag beside you, both faces kept exactly",
      explanation: "Name everyone who appears. Your photos hold their real likeness." },
    { id: "motions", label: "Motion", text: "Walking pace, the bag sways, ears twitch at the gulls, a slow look to camera",
      explanation: "Give the longer clip continuous motion or it starts to feel static." },
    { id: "stageDirections", label: "Four beats", text: "dunes wide → walk toward the water → the look to camera → settle as waves reach the sand",
      explanation: "Still four beats, roughly four seconds each. Let each one breathe." },
    { id: "lighting", label: "Lighting", text: "Low golden sun behind, soft sand bounce in front, long shadows",
      explanation: "Backlight at golden hour is the most forgiving light there is." },
    { id: "filter", label: "Filter", text: "Warm film stock, gentle grain, slightly lifted blacks",
      explanation: "The overall look, held steady across the whole clip." },
    { id: "camera", label: "Camera", text: "A single slow tracking shot alongside, 50mm, no cuts",
      explanation: "One continuous move suits the longer runtime better than several short ones." },
  ],
};

/** Sample 2 per tier — shown whole, so a finished prompt reads as one piece. */
export const PLAIN_VIDEO_SAMPLE_8S =
  "Lofi rainy-window cat: slow blink, ear twitch, tail tip curling, amber lamp light against a blue rainy night, soft film grain, one very slow dolly in, no cuts.";

export const PLAIN_VIDEO_SAMPLE_15S =
  "My dog in a firefighter's coat at a gleaming station: sits proudly, stands, walks to the engine and looks back, warm tungsten light and long shadows, rich cinematic colour, one continuous tracking shot, no cuts.";

export function annotatedVideoSampleFor(durationSeconds: 8 | 15): AnnotatedVideoSample {
  return durationSeconds === 15 ? ANNOTATED_VIDEO_SAMPLE_15S : ANNOTATED_VIDEO_SAMPLE_8S;
}

export function plainVideoSampleFor(durationSeconds: 8 | 15): string {
  return durationSeconds === 15 ? PLAIN_VIDEO_SAMPLE_15S : PLAIN_VIDEO_SAMPLE_8S;
}

export interface VideoIdeaChip {
  id: string;
  label: string;
  emoji: string;
  /** Applied to the Setting and Characters fields, which is where these ideas
   *  actually live — the rest of the script stays as the customer set it. */
  setting: string;
  characters: string;
}

export const VIDEO_IDEA_CHIPS: VideoIdeaChip[] = [
  { id: "famous_location", label: "Famous locations", emoji: "🗼",
    setting: "At the foot of the Eiffel Tower at golden hour, Paris rooftops behind",
    characters: "You and your pet together, faces and markings kept exactly" },
  { id: "historical_figure", label: "Historical figure", emoji: "👑",
    setting: "A candlelit Renaissance study lined with books and oil paintings",
    characters: "Your pet dressed as a Renaissance duchess, likeness kept exactly" },
  { id: "occupation", label: "Occupation costume", emoji: "🚒",
    setting: "A gleaming fire station with the engine polished and ready",
    characters: "Your pet in a firefighter's coat and helmet, likeness kept exactly" },
  { id: "holiday", label: "Holiday theme", emoji: "🎄",
    setting: "A cosy living room with a decorated tree and warm string lights",
    characters: "You and your pet by the fire, faces and markings kept exactly" },
];

/** What each duration actually buys, in the customer's terms rather than
 *  provider names. Shown on the duration picker so the choice is informed. */
export const VIDEO_DURATION_NOTES: Record<8 | 15, { headline: string; detail: string }> = {
  8: { headline: "8 seconds · with sound",
       detail: "Google's Veo 3. Generates its own audio. Best for one clear moment." },
  15: { headline: "15 seconds · longer story",
        detail: "Kling v3 Pro. Room for a journey between two places or a longer camera move." },
};
