// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBx9ogCLyaZ4Eus2p3M1imgc2bNjj33gz0",
  authDomain: "suggestion-97833.firebaseapp.com",
  projectId: "suggestion-97833",
  storageBucket: "suggestion-97833.firebasestorage.app",
  messagingSenderId: "935158947828",
  appId: "1:935158947828:web:b3d410681b3d17ceb9e3a1",
  measurementId: "G-V1K1RB9JYC"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);