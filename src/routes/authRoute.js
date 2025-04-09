// filepath: c:\Users\Beast\OneDrive\Desktop\Job_Portal\Job_Portal_Backend\src\routes\authRoutes.js
const express = require('express');
const axios = require('axios');
const router = express.Router();
require('dotenv').config();

const { SERVICEM8_CLIENT_ID, SERVICEM8_CLIENT_SECRET, SERVICEM8_REDIRECT_URI } = process.env;

// Redirect to ServiceM8 OAuth
router.get('/auth/servicem8', (req, res) => {
    console.log('Redirecting to ServiceM8 OAuth...');
    
    // Use go.servicem8.com instead of api.servicem8.com
    const authUrl = new URL('https://go.servicem8.com/oauth/authorize');
    
    const params = {
        client_id: SERVICEM8_CLIENT_ID,
        redirect_uri: SERVICEM8_REDIRECT_URI,
        response_type: 'code',
        scope: 'staff_locations staff_activity publish_sms publish_email vendor vendor_logo vendor_email read_locations manage_locations read_staff manage_staff read_customers manage_customers manage_customer_contacts read_jobs manage_jobs create_jobs read_job_contacts manage_job_contacts read_job_materials manage_job_materials read_job_categories manage_job_categories read_job_queues manage_job_queues read_tasks manage_tasks read_schedule manage_schedule read_inventory manage_inventory read_job_notes publish_job_notes read_job_photos publish_job_photos read_job_attachments publish_job_attachments read_inbox read_messages manage_notifications manage_templates manage_badges read_assets manage_assets',
        state: Math.random().toString(36).substring(7),
    };
    

    // Log debug information
    console.log('OAuth Parameters:', params);
    
    authUrl.search = new URLSearchParams(params).toString();
    console.log('Auth URL:', authUrl.toString());
    
    res.redirect(authUrl.toString());
});

// Handle OAuth callback
router.get('/auth/callback', async (req, res) => {
    console.log('Received callback with query params:', req.query);
    
    const { code, error, error_description } = req.query;

    // First check for errors
    if (error) {
        console.error('OAuth Error:', error, error_description);
        return res.status(400).json({
            error: true,
            message: error_description || 'Authorization failed'
        });
    }

    // Handle authorization code flow
    if (code) {
        let tokenData = null;
        
        try {
            // Create form data for token exchange
            const formData = new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                client_id: SERVICEM8_CLIENT_ID,
                client_secret: SERVICEM8_CLIENT_SECRET,
                redirect_uri: SERVICEM8_REDIRECT_URI
            });

            // Exchange code for access token
            const tokenResponse = await axios.post(
                'https://go.servicem8.com/oauth/access_token',
                formData.toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json'
                    }
                }
            );

            tokenData = tokenResponse.data;
            console.log('Token Response:', tokenData);

            // Update the user info request with the correct endpoint
            const userResponse = await axios.get('https://api.servicem8.com/api_1.0/staff/48c22336-9750-43d8-8e8a-224f6d8fd09b.json', {
                headers: {
                    'Authorization': `Bearer ${tokenData.access_token}`,
                    'Accept': 'application/json'
                }
            });

            return res.status(200).json({
                success: true,
                message: 'Authentication successful',
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token,
                company: userResponse.data
            });
        } catch (error) {
            console.error('API Request failed:', {
                status: error.response?.status,
                data: error.response?.data,
                endpoint: error.config?.url,
                method: error.config?.method
            });

            // Return auth data even if company info fetch failed
            if (tokenData) {
                return res.status(200).json({
                    success: true,
                    message: 'Authentication successful but company info fetch failed',
                    auth: {
                        access_token: tokenData.access_token,
                        refresh_token: tokenData.refresh_token,
                        expires_in: tokenData.expires_in,
                        token_type: tokenData.token_type,
                        scope: tokenData.scope
                    }
                });
            }

            return res.status(401).json({
                error: true,
                message: 'Authentication failed',
                details: error.response?.data || error.message
            });
        }
    }

    return res.status(400).json({
        error: true,
        message: 'Invalid callback response - missing authorization code',
        received: req.query
    });
});

module.exports = router;