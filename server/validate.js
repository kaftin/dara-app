// Whitelisted avatar colors — must match the swatches offered in the client.
// This is a whitelist rather than a hex-format check on purpose: it closes off
// any possibility of arbitrary CSS being injected into a style="background:..."
// attribute via this field.
const ALLOWED_AVATAR_COLORS = ['#378ADD', '#D85A30', '#0F9D6B', '#8B5CF6', '#D97706', '#DB2777'];

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;

function validateUsername(username) {
  if (typeof username !== 'string') return 'Username is required';
  const u = username.trim();
  if (!USERNAME_RE.test(u)) {
    return 'Username must be 3-24 characters: letters, numbers, underscores or hyphens only';
  }
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must include at least one letter and one number';
  }
  return null;
}

function validateAvatarColor(color) {
  if (!ALLOWED_AVATAR_COLORS.includes(color)) return 'Not a valid avatar color';
  return null;
}

function validateMessageText(text) {
  if (typeof text !== 'string') return 'Message is required';
  const t = text.trim();
  if (t.length < 1) return 'Message cannot be empty';
  if (t.length > 2000) return 'Message is too long (2000 character limit)';
  return null;
}

module.exports = {
  ALLOWED_AVATAR_COLORS,
  validateUsername,
  validatePassword,
  validateAvatarColor,
  validateMessageText
};
