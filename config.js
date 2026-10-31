// The only file you normally need to edit. When the app is updated later, keep this file as it is.
window.APP_CONFIG = {
  companyName: "Majani Mingi",

  // To make the data the same on every device, fill in these three (see README.md, step by step):
  firebaseDbUrl: "https://mmsl-contract-tracker-default-rtdb.asia-southeast1.firebasedatabase.app",   // copy it exactly from Firebase > Realtime Database, e.g. "https://your-project-default-rtdb.firebaseio.com"
  firebaseApiKey: "AIzaSyDSdcv1m0McPs0PeB5bJSSWxRM8kduHs0s",  // Firebase > Project settings > General > Web API Key
  adminEmails: [yasinambetsa@gmail.com],     // accounts allowed to edit, e.g. ["hr@yourcompany.com"]. Every other signed-in account can only view.

  // Used only when the Firebase values above are empty (the app then runs in this one browser).
  localPasswords: { admin: "1234", viewer: "6789" }
};
