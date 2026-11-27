// Shared guestbook settings. Every device reads these, including guests' phones that arrive from the QR code.
// Edit this file on GitHub to change them for everyone. Staff can also override most of them on one device
// from the hidden Staff panel (press and hold the top-left corner for 3 seconds).
window.GUESTBOOK_CONFIG = {
  // Cloudinary (no secret keys here — this file is public)
  cloudName: 'whgs8x00',
  uploadPreset: 'guestbook_kiosk',

  // Event details shown on screen and saved into each video and photo
  eventName: '[Event name]',
  names: '[Names]',            // e.g. "Mei & Daniel" — shown on the overlay
  eventDate: '',               // e.g. "12 December 2026"; leave empty to show today's date
  accent: '#A8473C',           // rose. Others that work well: #5E7A5F sage, #3E5A7A navy, #7A4A6B plum

  // Questions shown to guests who need an idea
  prompts: [
    'What’s your best advice for the couple?',
    'Share a favourite memory together',
    'What do you wish for them in the years ahead?',
    'How did you meet the hosts?',
    'Tell them something that made you smile today',
    'Describe the hosts in three words',
  ],

  // Defaults for each device. Staff can change these per device in the Staff panel.
  defaults: {
    maxSeconds: 90,        // recording time limit
    remindAt: 10,          // seconds before the end to remind guests (0 = off)
    quality: 'standard',   // 'saver' | 'standard' | 'high'
    sounds: true,          // countdown beeps and reminder chimes
    hostMessages: true,    // opening and closing messages from the hosts
    prompts: true,         // prompt cards during recording
    overlay: true,         // names and date saved into videos and photos
    photoFrame: 'classic', // 'classic' | 'floral' | 'none'
    voiceGuide: false,     // spoken instructions
    kiosk: true,           // full screen, camera kept on, return to start when idle
    idleSeconds: 90,       // go back to the start after this long with no taps
    thanksSeconds: 25,     // how long the thank-you screen (with its QR code) stays up
    pin: '2580',           // staff PIN — change it in the Staff panel on each device
  },
};
