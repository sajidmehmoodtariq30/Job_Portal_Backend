// filepath: c:\Users\Beast\OneDrive\Desktop\Job_Portal\Job_Portal_Backend\src\app.js
const express = require('express');
const authRoutes = require('./routes/authRoute');
const defaultRoutes = require('./routes/defaultRoute');
const app = express();

// Add middleware to parse JSON and query strings
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/', defaultRoutes);
app.use('/api', authRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});