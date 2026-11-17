/**
 * Copy into BOTH the admin and read-proxy projects when AUTH_PROVIDER=firebase.
 * The Google endpoint validates the ID token against the configured API key's
 * project. Decoded claims alone are never accepted as proof of identity.
 */
function _firebaseVerifyIdToken(token) {
  const properties = PropertiesService.getScriptProperties();
  const projectId = (properties.getProperty('FIREBASE_PROJECT_ID') || '').trim();
  const apiKey = (properties.getProperty('FIREBASE_API_KEY') || '').trim();
  if (!projectId || !apiKey) throw new Error('Firebase not configured');
  const claims = JSON.parse(Utilities.newBlob(
    Utilities.base64DecodeWebSafe(token.split('.')[1])).getDataAsString());
  const now = Date.now() / 1000;
  if (claims.aud !== projectId || claims.iss !== 'https://securetoken.google.com/' + projectId
      || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128
      || !Number.isFinite(claims.exp) || claims.exp <= now
      || !Number.isFinite(claims.iat) || claims.iat > now
      || !Number.isFinite(claims.auth_time) || claims.auth_time > now
      || typeof claims.email !== 'string' || !claims.email.trim() || claims.email_verified !== true
      || !claims.firebase || claims.firebase.sign_in_provider !== 'google.com'
      || claims.firebase.tenant !== undefined) throw new Error('invalid Firebase identity');

  const response = UrlFetchApp.fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(apiKey),
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ idToken: token }),
      muteHttpExceptions: true,
    });
  if (response.getResponseCode() !== 200) throw new Error('invalid Firebase idToken');
  const result = JSON.parse(response.getContentText());
  if (!Array.isArray(result.users) || result.users.length !== 1) throw new Error('invalid Firebase account');
  const user = result.users[0];
  if (!user || user.localId !== claims.sub || user.disabled
      || user.emailVerified !== true || typeof user.email !== 'string'
      || user.email.trim().toLowerCase() !== claims.email.trim().toLowerCase()
      || !Array.isArray(user.providerUserInfo)
      || !user.providerUserInfo.some((provider) => provider.providerId === 'google.com')
      || typeof user.validSince !== 'string' || !/^\d+$/.test(user.validSince)
      || !Number.isFinite(Number(user.validSince)) || Number(user.validSince) > claims.auth_time) {
    throw new Error('Firebase account disabled or revoked');
  }
  return user.email.trim().toLowerCase();
}
