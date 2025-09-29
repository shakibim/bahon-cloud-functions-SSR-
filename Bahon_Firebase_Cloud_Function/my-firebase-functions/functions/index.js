const { onValueWritten } = require('firebase-functions/v2/database');
const admin = require('firebase-admin');
const axios = require('axios');
admin.initializeApp();
const db = admin.database();
const firestore = admin.firestore();
/**
 * Process location data when new data is written to /current_location_table/{locationId}
 */
exports.processLocationData = onValueWritten('/current_location_table/{locationId}', async (event) => {
  try {
    // Access the new data
    const locationData = event.data.after.val();
    console.log('Received data at:', event.params.locationId, locationData);

    // Validate the incoming data
    if (!locationData || typeof locationData.lat !== 'number' || typeof locationData.lon !== 'number') {
      console.error('Invalid location data at:', event.params.locationId, locationData);
      return null;
    }

    const { lat, lon } = locationData;
    const timestamp = admin.firestore.Timestamp.fromMillis(Date.now());

    // Reference to the processed location table
    const processedLocationsRef = db.ref('processed_location_table');

    // Get the last processed location to calculate distance
    const lastLocationSnapshot = await processedLocationsRef.orderByChild('entry_no').limitToLast(1).once('value');
    const lastLocation = lastLocationSnapshot.exists() ? Object.values(lastLocationSnapshot.val())[0] : null;

    // Initialize distance and entry number
    let distanceFromPreviousKm = 0;
    let distanceSoFarKm = 0;
    let entryNo = 1;

    if (lastLocation && lastLocation.lat != null && lastLocation.lon != null) {
      entryNo = lastLocation.entry_no + 1;
      distanceFromPreviousKm = calculateDistance(lastLocation.lat, lastLocation.lon, lat, lon);
      distanceSoFarKm = (lastLocation.distance_so_far_km || 0) + distanceFromPreviousKm;
    }

    // Push the new processed location data to the database
    await processedLocationsRef.push({
      entry_no: entryNo,
      lat,
      lon,
      timestamp,
      distance_from_previous_km: parseFloat(distanceFromPreviousKm.toFixed(8)), // Rounded to 2 decimal places
      distance_so_far_km: parseFloat(distanceSoFarKm.toFixed(8)), // Rounded to 2 decimal places
    });

    console.log('Processed location data:', {
      entry_no: entryNo,
      timestamp,
      lat,
      lon,
      distance_from_previous_km: parseFloat(distanceFromPreviousKm.toFixed(8)),
      distance_so_far_km: parseFloat(distanceSoFarKm.toFixed(8)),
    });

    return null;
  } catch (error) {
    console.error('Error processing location data:', error);
    return null;
  }
});

/**
 * Helper function to calculate the Haversine distance between two points.
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} Distance in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => degrees * (Math.PI / 180);
  const R = 6371; // Earth's radius in kilometers

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in kilometers
}

exports.processScannedCard = onValueWritten('/scanned_card/{scanId}', async (event) => {
  try {
    const scanData = event.data.after.val();
    if (!scanData || !scanData.card_no) {
      console.error('No card number found in scan data!');
      return null;
    }

    const { card_no: cardNo } = scanData;
    const timestamp = admin.firestore.Timestamp.fromMillis(Date.now());

    console.log(`Scanned card: ${cardNo}, Timestamp: ${timestamp}`);

    const processedScannedCardRef = db.ref('processed_scanned_card');
    const onBoardRef = db.ref('on_board');
    const processedLocationsRef = db.ref('processed_location_table');

    // Get the last location of the bus
    const lastLocation = await getLastLocation(processedLocationsRef);
    if (!lastLocation) {
      console.error('No location data found!');
      return null;
    }

    const { lat, lon, distance_so_far_km } = lastLocation;

    // Get user data from Firestore by card number
    const userData = await getUserByCardNumber(cardNo);
    if (!userData) {
      console.error('No user found for this card number!');
      return null;
    }

    const { uid } = userData;

    // Determine if the user is entering or exiting
    const status = await handleBoardingStatus(onBoardRef, uid);

    // If it's an entry, save the current distance
    if (status === 'entry') {
      const processedCardData = {
        entry_no: timestamp,
        timestamp,
        uid,
        location: { lat, lon },
        distance_so_far_km: parseFloat(distance_so_far_km.toFixed(8)), // Save the distance for entry
        status,
        pIndex: lastLocation.entry_no,
      };

      // Save processed scan data
      await processedScannedCardRef.push(processedCardData);
      console.log(`Processed scanned card: ${cardNo}, Status: ${status}`);

      // Mark user as "on journey"
      await firestore.collection('users').doc(uid).update({ onjourney: true });
    } else if (status === 'exit') {
      // Retrieve the last entry data for the user
      const entrySnapshot = await processedScannedCardRef
        .orderByChild('uid')
        .equalTo(uid)
        .limitToLast(1)
        .once('value');

      if (!entrySnapshot.exists()) {
        console.error('No entry data found for the user!');
        return null;
      }

      const entryData = Object.values(entrySnapshot.val())[0];
      const entryDistanceSoFarKm = entryData.distance_so_far_km;
      const entryPIndex = entryData.pIndex; 
      const exitPIndex = lastLocation.entry_no; 
   

      // Calculate the traveled distance
      const traveledDistanceKm = parseFloat((distance_so_far_km - entryDistanceSoFarKm).toFixed(8));

      console.log(`Traveled Distance: ${traveledDistanceKm} km`);

      // Handle logic for exit (calculate fare, save journey data)
      await handleExit(userData, uid, lat, lon, traveledDistanceKm,entryPIndex,exitPIndex);

      // Clear "on journey" flag for the user
      await firestore.collection('users').doc(uid).update({ onjourney: false });
    }

    return null;
  } catch (error) {
    console.error('Error processing scanned card:', error);
    return null;
  }
});

// Helper function to get the last known location from the location table
async function getLastLocation(processedLocationsRef) {
  const lastLocationSnapshot = await processedLocationsRef
    .orderByChild('entry_no')
    .limitToLast(1)
    .once('value');
  return lastLocationSnapshot.exists() ? Object.values(lastLocationSnapshot.val())[0] : null;
}

// Helper function to get user data from Firestore by card number
async function getUserByCardNumber(cardNo) {
  const userSnapshot = await firestore.collection('users')
    .where('card_no', '==', cardNo)
    .limit(1)
    .get();

  if (userSnapshot.empty) {
    console.error(`No user found for card number: ${cardNo}`);
    return null;
  }

  const userData = userSnapshot.docs[0].data();
  const uid = userSnapshot.docs[0].id; // UID is the document ID
  return { uid, ...userData };
}

// Helper function to check the boarding status (entry or exit)
async function handleBoardingStatus(onBoardRef, uid) {
  const onBoardSnapshot = await onBoardRef.child(uid).once('value');
  const isOnBoard = onBoardSnapshot.exists();

  if (isOnBoard) {
    // Remove user from 'on_board' if exiting
    await onBoardRef.child(uid).remove();
    
    return 'exit';
  } else {
    // Fetch the latest entry_no from processed_location_table
    const processedLocationsRef = db.ref('processed_location_table');
    const lastLocationSnapshot = await processedLocationsRef
      .orderByChild('entry_no')
      .limitToLast(1)
      .once('value');

    if (lastLocationSnapshot.exists()) {
      const lastLocation = Object.values(lastLocationSnapshot.val())[0];
      const latestEntryNo = lastLocation.entry_no;

      // Save user as "on journey" with the latest entry_no
      await onBoardRef.child(uid).set({
        entry_no: latestEntryNo,
      });

      return 'entry';
    } else {
      console.error('No latest location entry found while processing boarding status!');
      return null;
    }
  }
}

// Function to handle exit logic, calculate fare, total time, and save the journey data
async function handleExit(userData, uid, lat, lon, distanceSoFarKm, entryPIndex, exitPIndex) {
  try {
    // Fetch fare per kilometer from Firestore
    const fareDoc = await firestore.collection('farePerKm').doc('266565').get();
    const farePerKm = fareDoc.exists ? fareDoc.data().fpk : 0;

    // Calculate fare based on the distance traveled
    const fare = farePerKm * distanceSoFarKm;

    // Retrieve the latest processed_scanned_card entry for the user
    const processedCardSnapshot = await db
      .ref('processed_scanned_card')
      .orderByChild('uid')
      .equalTo(uid)
      .limitToLast(1)
      .once('value');

    if (!processedCardSnapshot.exists()) {
      console.error(`No matching processed_scanned_card entry found for UID: ${uid}`);
      return;
    }

    const processedCardData = Object.values(processedCardSnapshot.val())[0];
    const entryTimestamp = processedCardData.entry_no; // Assuming entry_no is a Timestamp

    if (!entryTimestamp) {
      console.error(`Entry time is missing or invalid for UID: ${uid}`);
      return;
    }

    // Calculate exit time and journey duration
    const exitTimestamp = admin.firestore.Timestamp.now(); // Current time as Firestore Timestamp
    const totalTime = (exitTimestamp.seconds - entryTimestamp.seconds) / 60; // Total time in minutes

    // Perform reverse geocoding to determine entry and exit points
    const entryPoint = await getLocationName(lat, lon); // Entry point location
    const exitPoint = await getLocationName(lat, lon); // Exit point location
    const journeyPath = await fetchJourneyPath(entryPIndex, exitPIndex);

    // Prepare journey data
    const journeyData = {
      entry_time: entryTimestamp,
      exit_time: exitTimestamp,
      entry_point: entryPoint,
      exit_point: exitPoint,
      fare,
      total_time_taken: totalTime,
      distance_travelled_km: distanceSoFarKm,
      fpkm: farePerKm,
      path: journeyPath,
    };

    // Save journey data to Firestore
    await firestore.collection('users').doc(uid).collection('journeys').add(journeyData);

    // Update user's journey status
    const userRef = firestore.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const user = userDoc.data();

    // Ensure necessary fields exist
    let { total_spend_current_month = 0, balance = 0, bonus = 0, count_bonus = 0, last_reset_month } = user;
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;

    // Reset monthly values if a new month starts
    if (currentMonth !== last_reset_month) {
      total_spend_current_month = 0;
      count_bonus = 0;
      bonus = 0;
      await userRef.update({
        total_spend_current_month: 0,
        count_bonus: 0,
        bonus: 0,
        last_reset_month: currentMonth,
      });
    }

    // Deduct fare
    if (bonus >= fare) {
      bonus -= fare;
    } else if (bonus > 0) {
      balance = balance + bonus - fare;
      bonus = 0;
    } else {
      balance -= fare;
    }
    
    // Update total spend for the current month
    total_spend_current_month += fare;

    // Check if bonus needs to be granted
    if (total_spend_current_month > 1000 && count_bonus === 0) {
      bonus = 100;
      count_bonus = 1;
      await userRef.update({ bonus, count_bonus });
    }


    // Update user data
    await userRef.update({
      balance,
      bonus,
      total_spend_current_month,
      onjourney: false,
    });

    console.log('Journey data saved and fare processed successfully.');
  } catch (error) {
    console.error('Error processing exit:', error);
  }
}

async function getLocationName(lat, lon) {
  try {
    const response = await axios.get(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
    if (response.data && response.data.display_name) {
      return response.data.display_name;
    }
    return 'Unknown';
  } catch (error) {
    console.error('Error in reverse geocoding:', error);
    return 'Unknown';
  }
}

async function fetchJourneyPath(entryPIndex, exitPIndex) {
  try {
    const processedLocationsRef = db.ref('processed_location_table');
    const path = [];

    // Collect all locations between entryPIndex and exitPIndex
    for (let i = entryPIndex; i <= exitPIndex; i++) {
      const locationSnapshot = await processedLocationsRef.orderByChild('entry_no').equalTo(i).once('value');
      if (!locationSnapshot.exists()) {
        console.warn(`No location found for entry_no: ${i}`);
        continue;
      }

      const locationData = Object.values(locationSnapshot.val())[0];
      const { lat, lon } = locationData;

      // Add location to the path array
      path.push({ lat, lon });
    }

    return path; // Return the path array
  } catch (error) {
    console.error('Error fetching journey path:', error);
    return [];
  }
}