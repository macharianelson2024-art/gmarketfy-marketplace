
// True if timestamp1 is strictly later than timestamp2.

function isTimestampGreater(latestNotification, lastSeenNotification) {
  // Edge case safety check: make sure both exist and have the Firebase conversion method
  if (!latestNotification || !lastSeenNotification || typeof latestNotification.toMillis !== 'function' || typeof lastSeenNotification.toMillis !== 'function') {
    console.error("Yo bro, one of these isn't a valid Firestore Timestamp!");
    return false;
  }

  // Convert both to milliseconds (Unix epoch time) and compare
  return latestNotification.toMillis() > lastSeenNotification.toMillis();
}


export { isTimestampGreater };