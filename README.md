# Bahon – Server-Side Processing (SSR)

This repository contains the **server-side Firebase Cloud Functions** for **Bahon**, an IoT-based **Smart Public Transportation System**.
It automates **real-time location tracking**, **fare calculation**, and **journey management** for users scanning **RFID or QR codes** while boarding and exiting public transport.

## Tech Stack

* **Firebase Functions (Node.js)** – Cloud backend
* **Firebase Realtime Database** – Live data stream (location, card scans)
* **Firebase Firestore** – Persistent user and fare data
* **Axios** – Reverse geocoding using OpenStreetMap API
* **Haversine Formula** – Accurate distance calculation between coordinates

## 🚀 Deployment

1. Install dependencies

   ```bash
   npm install
   ```

2. Deploy to Firebase Functions

   ```bash
   firebase deploy --only functions
   ```

## API Used

* **OpenStreetMap Nominatim API**
  Used for reverse geocoding (to convert GPS coordinates to location names).


##  Author

**SK. Md. Shakib Imran**
Department of CSE, East West University
📍 Dhaka, Bangladesh
📧 [shakibim233@gmail.com](mailto:shakibim233@gmail.com)




