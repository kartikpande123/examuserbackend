const firebaseAdmin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

// Use the service account file path from environment variables
const serviceAccountPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT);
const serviceAccount = require(serviceAccountPath);

// Initialize Firebase Admin SDK with storageBucket parameter
const firebaseApp = firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET // Add this line
});

// Create Firestore and Realtime Database instances
const firestore = firebaseAdmin.firestore();
const realtimeDB = firebaseAdmin.database();

module.exports = {
    firebaseAdmin,
    firebaseApp,
    firestore,
    realtimeDB
};