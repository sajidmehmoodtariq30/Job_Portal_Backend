const express = require('express');
const servicem8 = require('@api/servicem8');
const router = express.Router();
require('dotenv').config();
const { getValidAccessToken } = require('../utils/tokenManager');
const { getUserEmails } = require('../utils/userEmailManager');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { sendBusinessNotification, NOTIFICATION_TYPES } = require('../utils/businessNotifications');

// Cache for locations to avoid repeated API calls
let locationsCache = null;
let locationsCacheExpiry = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Helper function to get all locations with caching
const getAllLocations = async () => {
    const now = Date.now();
    if (locationsCache && now < locationsCacheExpiry) {
        return locationsCache;
    }
    
    try {
        const { data } = await servicem8.getLocationAll();
        locationsCache = data;
        locationsCacheExpiry = now + CACHE_DURATION;
        return data;
    } catch (error) {
        console.error('Error fetching locations for resolution:', error);
        return [];
    }
};

// Helper function to resolve location data for jobs
const resolveJobLocationData = async (jobs) => {
    // Always work with arrays, but remember the original input type
    const wasArray = Array.isArray(jobs);
    if (!wasArray) {
        jobs = [jobs];
    }
    
    // Get all locations once
    const locations = await getAllLocations();
    
    // Create a map for quick lookup
    const locationMap = new Map();
    locations.forEach(location => {
        if (location.uuid) {
            locationMap.set(location.uuid, location);
        }
    });
    
    // Resolve location data for each job
    const resolvedJobs = jobs.map(job => {
        if (job.location_uuid && locationMap.has(job.location_uuid)) {
            const location = locationMap.get(job.location_uuid);
            
            // Populate location fields that frontend expects
            return {
                ...job,
                location_address: formatLocationAddress(location),
                location_name: location.name,
                location_city: location.city,
                location_state: location.state,
                location_postcode: location.post_code,
                location_country: location.country,
                // Populate geo fields for compatibility
                geo_street: location.line1,
                geo_city: location.city,
                geo_state: location.state,
                geo_postcode: location.post_code,
                geo_country: location.country,
                // Keep job_address as fallback for legacy jobs
                job_address: job.job_address || formatLocationAddress(location)
            };
        }
        return job;
    });
    
    // Return single object only if input was a single object, otherwise always return array
    return wasArray ? resolvedJobs : resolvedJobs[0];
};

// Helper function to format location address
const formatLocationAddress = (location) => {
    if (!location) return null;
    
    const parts = [];
    if (location.line1) parts.push(location.line1);
    if (location.line2) parts.push(location.line2);
    if (location.city) parts.push(location.city);
    if (location.state) parts.push(location.state);
    if (location.post_code) parts.push(location.post_code);
    if (location.country && location.country !== 'Australia') parts.push(location.country);
    
    return parts.join(', ');
};

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5000';

// Helper function to get portal URL
const getPortalUrl = () => {
    return process.env.PORTAL_URL || 'http://localhost:3000';
};

// Helper function to send notification for job events
const sendJobNotification = async (type, jobData, userId) => {
    try {
        // Check if notifications for this type are enabled in the notification settings
        // This will make an API call to get the current notification settings first
        let notificationSettings;
        try {
            const settingsResponse = await axios.get(`${API_BASE_URL}/api/notifications/settings`);
            notificationSettings = settingsResponse.data;
            
            // Early return if email notifications are disabled globally or for this type
            if (!notificationSettings.channels.email || !notificationSettings.types[type]) {
                console.log(`Email notifications are disabled for type '${type}' or globally. Skipping notification.`);
                return false;
            }
        } catch (error) {
            console.error('Error fetching notification settings:', error.message);
            // Default to not sending if we can't verify settings
            return false;
        }
        
        // Get user's primary email - await the async call
        const userEmailData = await getUserEmails(userId || 'admin-user');
        if (!userEmailData || !userEmailData.primaryEmail) {
            console.log(`No primary email found for user ${userId || 'admin-user'}, skipping notification`);
            return false;
        }

        // Format date if available
        let formattedDate = '';
        if (jobData.start_date) {
            const date = new Date(jobData.start_date);
            formattedDate = date.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
        }

        // Prepare data for email template
        const notificationData = {
            jobId: jobData.job_id || jobData.uuid,
            jobDescription: jobData.job_description || jobData.description || 'No description provided',
            client: jobData.client_name || jobData.company_name || 'Unknown Client',
            status: jobData.status || jobData.job_status || '',
            oldStatus: jobData.oldStatus || '',
            newStatus: jobData.newStatus || '',
            date: formattedDate,
            amount: jobData.amount,
            dueDate: jobData.due_date,
            invoiceId: jobData.invoice_id,
            quoteId: jobData.quote_id,
            portalUrl: `${getPortalUrl()}/admin/jobs`,
            changes: jobData.changes || []
        };

        // Send notification
        const response = await axios.post(`${API_BASE_URL}/api/notifications/send-templated`, {
            type,
            data: notificationData,
            recipientEmail: userEmailData.primaryEmail
        });

        return response.status === 200;
    } catch (error) {
        console.error(`Error sending ${type} notification:`, error.message);
        return false;
    }
};

// Middleware to ensure a valid token for all job routes
const ensureValidToken = async (req, res, next) => {
    try {
        // This will refresh the token if it's expired
        const accessToken = await getValidAccessToken();
        
        // Store the token in the request for route handlers to use
        req.accessToken = accessToken;
        
        // Set the auth for the ServiceM8 API
        servicem8.auth(accessToken);
        
        next();
    } catch (error) {
        console.error('Token validation error:', error);
        return res.status(401).json({
            error: true,
            message: 'Failed to authenticate with ServiceM8. Please try again.'
        });
    }
};

// Apply the token middleware to all routes
router.use(ensureValidToken);

// Get a single job by UUID
router.get('/job/:uuid', async (req, res) => {
    try {
        const { uuid } = req.params;
        console.log(`Fetching job details for UUID: ${uuid}`);
        
        // Use the ServiceM8 API to get a single job
        const result = await servicem8.getJobSingle({ uuid });
        
        // Process the job data to ensure consistent field names for frontend
        let jobData = result.data;
        
        // If job has description but no job_description, copy it to job_description
        if (jobData.description && !jobData.job_description) {
            jobData.job_description = jobData.description;
        }
        // If job has job_description but no description, copy it to description
        if (jobData.job_description && !jobData.description) {
            jobData.description = jobData.job_description;
        }
        
        // Resolve location data for this job
        const [jobWithLocation] = await resolveJobLocationData([jobData]);
        
        // Get client name if company_uuid exists
        if (jobWithLocation.company_uuid) {
            try {
                const clientEmails = await getUserEmails(jobWithLocation.company_uuid);
                if (clientEmails && clientEmails.clientName) {
                    jobWithLocation.client = clientEmails.clientName;
                }
            } catch (clientError) {
                console.warn('Could not fetch client name:', clientError.message);
                jobWithLocation.client = 'Unknown Client';
            }
        }
        
        res.status(200).json({
            success: true,
            data: jobWithLocation
        });
    } catch (error) {
        console.error('Error fetching job details:', error);
        res.status(500).json({
            error: true,
            message: 'Failed to fetch job details.',
            details: error.message
        });
    }
});

// Get all jobs - SECURITY UPDATED: Add client filtering
router.get('/jobs', async (req, res) => {
    // Log the access token being used
    console.log('Using access token:', req.accessToken);

    try {
        const { data } = await servicem8.getJobAll();
        let jobsToReturn = data;
        
        // SECURITY FIX: Check if this is a client request and filter accordingly
        const clientId = req.headers['x-client-uuid'] || 
                       req.headers['client-id'] || 
                       req.query.clientId;
                       
        if (clientId) {
            // Client requests should only see their own jobs
            console.log(`Client-specific request detected for: ${clientId}`);
            jobsToReturn = data.filter(job => {
                return job.company_uuid === clientId || 
                       job.created_by_staff_uuid === clientId ||
                       job.client_uuid === clientId;
            });
            console.log(`Filtered ${jobsToReturn.length} jobs for client ${clientId} out of ${data.length} total jobs`);
        } else {
            // Admin requests can see all jobs
            console.log('Admin request - returning all jobs');
        }
        
        // Process the job data to ensure consistent field names for frontend
        const processedData = jobsToReturn.map(job => {
            // If job has description but no job_description, copy it to job_description
            if (job.description && !job.job_description) {
                job.job_description = job.description;
            }
            // If job has job_description but no description, copy it to description
            if (job.job_description && !job.description) {
                job.description = job.job_description;
            }
            return job;
        });
          // Resolve location data for all jobs
        try {
            console.log('About to resolve location data for jobs. Jobs count:', processedData.length);
            console.log('Sample job before location resolution:', processedData[0]?.uuid);
            const jobsWithLocation = await resolveJobLocationData(processedData);
            console.log('Location resolution completed. Result type:', Array.isArray(jobsWithLocation) ? 'array' : 'object');
            console.log('Result count:', Array.isArray(jobsWithLocation) ? jobsWithLocation.length : 'single object');
            console.log('Sending response with jobs:', Array.isArray(jobsWithLocation) ? jobsWithLocation.length : 1);
            res.status(200).json(jobsWithLocation);
        } catch (locationError) {
            console.error('Error resolving location data:', locationError);
            // Return jobs without location data if resolution fails
            res.status(200).json(processedData);
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: true,
            message: 'Failed to fetch jobs.'
        });
    }
});

// Get jobs filtered by client UUID - optimized for client portal
router.get('/jobs/client/:clientUuid', async (req, res) => {
    const { clientUuid } = req.params;
    
    // Validate client UUID
    if (!clientUuid) {
        return res.status(400).json({
            error: true,
            message: 'Client UUID is required.'
        });
    }
    
    console.log(`Fetching jobs for client UUID: ${clientUuid}`);
    console.log('Using access token:', req.accessToken);    try {
        const { data } = await servicem8.getJobAll();
        // Server-side filtering by client UUID
        const clientJobs = data.filter(job => {
            return job.company_uuid === clientUuid || 
                   job.created_by_staff_uuid === clientUuid ||
                   job.client_uuid === clientUuid;
        });
        
        console.log(`Found ${clientJobs.length} jobs for client ${clientUuid} out of ${data.length} total jobs`);
        
        // If no jobs found for client, return mock data for demo purposes
        if (clientJobs.length === 0) {
            console.log(`No jobs found for client ${clientUuid}, returning mock data for demo`);
            const mockJobs = [
                {
                    uuid: 'mock-job-001',
                    generated_job_id: 'JOB-2025-0423', // Use ServiceM8's generated job ID format
                    job_name: 'Network Installation',
                    job_description: 'Install new network infrastructure including switches and access points',
                    status: 'In Progress',
                    date: new Date().toISOString().split('T')[0],
                    due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                    company_uuid: clientUuid,
                    created_by_staff_uuid: clientUuid,
                    location_address: 'Main Office',
                    job_address: 'Main Office',
                    assigned_to_name: 'Alex Johnson',
                    attachments_count: 2
                },
                {
                    uuid: 'mock-job-002',
                    generated_job_id: 'JOB-2025-0418', // Use ServiceM8's generated job ID format
                    job_name: 'Digital Signage Installation',
                    job_description: 'Install 3 digital signage displays in reception area',
                    status: 'Completed',
                    date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                    completed_date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                    company_uuid: clientUuid,
                    created_by_staff_uuid: clientUuid,
                    location_address: 'Main Office',
                    job_address: 'Main Office',
                    assigned_to_name: 'Sarah Davis',
                    attachments_count: 3
                },
                {
                    uuid: 'mock-quote-001',
                    generated_job_id: 'QUOTE-2025-0422', // Use ServiceM8's generated job ID format
                    job_name: 'Security System Upgrade',
                    job_description: 'Upgrade existing security cameras to 4K resolution',
                    status: 'Quote',
                    date: new Date().toISOString().split('T')[0],
                    due_date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                    company_uuid: clientUuid,
                    created_by_staff_uuid: clientUuid,
                    location_address: 'Warehouse',
                    job_address: 'Warehouse',
                    total_amount: '4850.00',
                    attachments_count: 1
                }
            ];
            return res.status(200).json(mockJobs);
        }
        
        // Process the job data to ensure consistent field names for frontend
        const processedData = clientJobs.map(job => {
            // If job has description but no job_description, copy it to job_description
            if (job.description && !job.job_description) {
                job.job_description = job.description;
            }
            // If job has job_description but no description, copy it to description
            if (job.job_description && !job.description) {
                job.description = job.job_description;
            }
            return job;
        });
        
        // Resolve location data for all client jobs
        try {
            const jobsWithLocation = await resolveJobLocationData(processedData);
            res.status(200).json(jobsWithLocation);
        } catch (locationError) {
            console.error('Error resolving location data for client jobs:', locationError);
            // Return jobs without location data if resolution fails
            res.status(200).json(processedData);
        }
    } catch (err) {
        console.error('Error fetching client jobs:', err);
        res.status(500).json({
            error: true,
            message: 'Failed to fetch client jobs.',
            details: err.message
        });
    }
});

// Delete all jobs
router.delete('/jobs/deleteAll', async (req, res) => {
    try {
        // Fetch all jobs
        const { data: jobs } = await servicem8.getJobAll();

        // Delete each job one by one
        for (const job of jobs) {
            await servicem8.deleteJobSingle({ uuid: job.uuid });
            console.log(`Deleted job with UUID: ${job.uuid}`);
        }

        res.status(200).json({ message: 'All jobs deleted successfully.' });
    } catch (error) {
        console.error('Error deleting jobs:', error);
        res.status(500).json({ error: 'Failed to delete all jobs.' });
    }
});

// Create a new job
router.post('/jobs/create', async (req, res) => {
    try {
        // Get job data from request body and create a new object to modify
        const jobData = { ...req.body };
        
        // Handle category_uuid - validate if provided
        if (jobData.category_uuid) {
            try {
                // Validate that the category exists and is accessible
                const categoryResponse = await servicem8.getCategorySingle({ uuid: jobData.category_uuid });
                if (categoryResponse.data && categoryResponse.data.active === 1) {
                    console.log(`Using valid category_uuid: ${jobData.category_uuid}`);
                } else {
                    console.log(`Invalid or inactive category_uuid: ${jobData.category_uuid}, removing it`);
                    delete jobData.category_uuid;
                }
            } catch (categoryError) {
                console.log(`Category validation failed for ${jobData.category_uuid}, removing it:`, categoryError.message);
                delete jobData.category_uuid;
            }
        }
        
        // Handle the description field - ServiceM8 API ignores "description" field
        // Use job_description as the primary field for ServiceM8
        if (jobData.description && !jobData.job_description) {
            jobData.job_description = jobData.description;
        }
        
        // CONFIRMED working ServiceM8 status values: "Completed", "Quote", "Work Order"
        if (jobData.status) {
            // Map status values to confirmed working ServiceM8 status values
            const statusMapping = {
                'quote': 'Quote',
                'work order': 'Work Order',
                'completed': 'Completed'
            };
            
            // Check if we have a direct match for confirmed working statuses
            if (["Completed", "Quote", "Work Order"].includes(jobData.status)) {
                // Status is already in the correct format, no need to change
                console.log(`Status "${jobData.status}" is valid.`);
            } else {
                // Try to normalize the status value
                const normalizedStatus = jobData.status.toLowerCase();
                if (statusMapping[normalizedStatus]) {
                    jobData.status = statusMapping[normalizedStatus];
                    console.log(`Normalized status from "${req.body.status}" to "${jobData.status}"`);
                } else {
                    // Default to "Work Order" if status is invalid
                    console.log(`Invalid status "${jobData.status}" provided. Defaulting to "Work Order".`);
                    jobData.status = "Work Order";
                }
            }
        } else {
            // If no status provided, default to Work Order
            jobData.status = "Work Order";
            console.log("No status provided. Defaulting to 'Work Order'.");
        }
        
        // Ensure active is set to 1 (required by ServiceM8)
        if (!jobData.active) {
            jobData.active = 1;
        }
        
        console.log('Creating job with payload:', jobData);
          // Use postJobCreate to create the job
        const result = await servicem8.postJobCreate(jobData);
        console.log('Job created successfully:', result.data);
        
        // Send business workflow notification
        await sendBusinessNotification(NOTIFICATION_TYPES.JOB_CREATED, {
            jobId: result.data.uuid,
            jobDescription: jobData.job_description || jobData.description || 'New job created',
            client: jobData.company_name,
            clientUuid: jobData.company_uuid || jobData.created_by_staff_uuid,
            status: jobData.status,
            date: jobData.date,
            createdBy: req.body.userId || 'admin-user'
        });

        res.status(201).json({
            success: true,
            message: 'Job created successfully',
            data: result.data
        });
    } catch (error) {
        console.error('Error creating job:', error);
        
        // Provide more detailed error information to help with debugging
        res.status(500).json({
            error: true,
            message: 'Failed to create job.',
            details: error.message,
            serviceM8Error: error.data || 'No additional details provided by ServiceM8'
        });
    }
});

// Update a job
router.put('/jobs/:uuid', async (req, res) => {
    try {
        const { uuid } = req.params;
        
        // Get the existing job data to track changes
        const { data: existingJob } = await servicem8.getJobSingle({ uuid });
        
        // Create job update payload
        const jobUpdate = {
            uuid,
            ...req.body
        };
        
        // Standardize status field
        if (jobUpdate.status) {
            // Map status values to confirmed working ServiceM8 status values
            const statusMapping = {
                'quote': 'Quote',
                'work order': 'Work Order',
                'completed': 'Completed'
            };
            
            // Try to normalize the status value
            const normalizedStatus = jobUpdate.status.toLowerCase();
            if (statusMapping[normalizedStatus]) {
                jobUpdate.status = statusMapping[normalizedStatus];
            }
        }
        
        // Track changes for notification email
        const changes = [];
        
        // Check for status change - this is important for workflow notifications
        let statusChanged = false;
        if (existingJob.status !== jobUpdate.status && jobUpdate.status) {
            changes.push(`Status changed from "${existingJob.status || 'None'}" to "${jobUpdate.status}"`);
            statusChanged = true;
        }
        
        // Check for description change
        if (existingJob.description !== jobUpdate.description && jobUpdate.description) {
            changes.push(`Description changed from "${existingJob.description || 'None'}" to "${jobUpdate.description}"`);
        }
        
        // Check for start date change
        if (existingJob.start_date !== jobUpdate.start_date && jobUpdate.start_date) {
            const oldDate = existingJob.start_date ? new Date(existingJob.start_date).toLocaleDateString() : 'None';
            const newDate = new Date(jobUpdate.start_date).toLocaleDateString();
            changes.push(`Start date changed from ${oldDate} to ${newDate}`);
        }
          // Update job in ServiceM8
        const result = await servicem8.putJobEdit(jobUpdate);
        
        // Send business workflow notification if there were changes
        if (changes.length > 0) {
            // Send status update notification if status changed
            if (statusChanged) {
                await sendBusinessNotification(NOTIFICATION_TYPES.JOB_STATUS_UPDATE, {
                    jobId: jobUpdate.uuid,
                    jobDescription: jobUpdate.description || existingJob.description,
                    client: existingJob.company_name,
                    clientUuid: existingJob.company_uuid || existingJob.created_by_staff_uuid,
                    oldStatus: existingJob.status,
                    newStatus: jobUpdate.status,
                    changes: changes,
                    updatedBy: req.body.userId || 'admin-user'
                });
            }
        }

        res.status(200).json({
            success: true,
            message: 'Job updated successfully',
            data: jobUpdate,
            changes
        });
    } catch (error) {
        console.error('Error updating job:', error);
        res.status(500).json({
            error: true,
            message: 'Failed to update job.',
            details: error.message
        });
    }
});

// Create a new quote
router.post('/quotes/create', async (req, res) => {
    try {
        const { jobUuid, amount, details } = req.body;
        
        if (!jobUuid) {
            return res.status(400).json({
                error: true,
                message: 'Job UUID is required to create a quote'
            });
        }
        
        // Get the job details first
        const { data: jobData } = await servicem8.getJobSingle({ uuid: jobUuid });
        
        if (!jobData) {
            return res.status(404).json({
                error: true,
                message: 'Job not found'
            });
        }
        
        // Create a quote object
        const quoteData = {
            uuid: req.body.uuid || uuidv4(), // Generate UUID if not provided
            job_uuid: jobUuid,
            amount: amount || 0,
            description: details || jobData.description || 'Quote',
            active: 1
        };
        
        // Create the quote in ServiceM8
        const result = await servicem8.postQuoteCreate(quoteData);
        
        // If quote created successfully, update job status to Quote if needed
        if (result.data && jobData.status !== 'Quote') {
            await servicem8.putJobEdit({
                uuid: jobUuid,
                status: 'Quote'
            });
        }
        
        // Send notification about the new quote
        await sendJobNotification('quoteCreation', {
            ...result.data,
            jobId: jobData.job_id,
            job_description: jobData.description,
            client_name: jobData.company_name,
            amount: amount,
            date: new Date().toISOString().split('T')[0]
        }, req.body.userId || 'admin-user');
        
        res.status(201).json({
            success: true,
            message: 'Quote created successfully',
            data: result.data
        });
    } catch (error) {
        console.error('Error creating quote:', error);
        res.status(500).json({
            error: true,
            message: 'Failed to create quote',
            details: error.message
        });
    }
});

// Create a new invoice
router.post('/invoices/create', async (req, res) => {
    try {
        const { jobUuid, amount, dueDate, details } = req.body;
        
        if (!jobUuid) {
            return res.status(400).json({
                error: true,
                message: 'Job UUID is required to create an invoice'
            });
        }
        
        // Get the job details first
        const { data: jobData } = await servicem8.getJobSingle({ uuid: jobUuid });
        
        if (!jobData) {
            return res.status(404).json({
                error: true,
                message: 'Job not found'
            });
        }
        
        // Create an invoice object
        const invoiceData = {
            uuid: req.body.uuid || uuidv4(), // Generate UUID if not provided
            job_uuid: jobUuid,
            amount: amount || 0,
            description: details || jobData.description || 'Invoice',
            due_date: dueDate || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Default to 14 days from now
            active: 1
        };
        
        // Create the invoice in ServiceM8
        const result = await servicem8.postInvoiceCreate(invoiceData);
        
        // Send notification about the new invoice
        await sendJobNotification('invoiceGenerated', {
            ...result.data,
            jobId: jobData.job_id,
            job_description: jobData.description,
            client_name: jobData.company_name,
            amount: amount,
            dueDate: invoiceData.due_date
        }, req.body.userId || 'admin-user');
        
        res.status(201).json({
            success: true,
            message: 'Invoice created successfully',
            data: result.data
        });
    } catch (error) {
        console.error('Error creating invoice:', error);
        res.status(500).json({
            error: true,
            message: 'Failed to create invoice',
            details: error.message
        });
    }
});

// Get jobs filtered by user role and categories
router.get('/jobs/role/:userRole', async (req, res) => {
    try {
        const { userRole } = req.params;
        const { category, status, type, site } = req.query;
        
        console.log(`Fetching jobs for role: ${userRole}, category: ${category}, status: ${status}, type: ${type}, site: ${site}`);
        
        // Get all jobs from ServiceM8
        const jobsResponse = await servicem8.getJobAll();
        let jobs = jobsResponse.data;
        
        // Get all categories to cross-reference
        const categoriesResponse = await servicem8.getCategoryAll();
        const categories = categoriesResponse.data.filter(cat => cat.active === 1);
        
        // Create a map of category UUIDs to category info for quick lookup
        const categoryMap = new Map();
        categories.forEach(cat => {
            categoryMap.set(cat.uuid, {
                ...cat,
                category_type: getCategoryType(cat.name),
                allowed_roles: getAllowedRoles(cat.name)
            });
        });
        
        // Apply role-based filtering
        jobs = jobs.filter(job => {
            // Check if user role can access this job based on its category
            if (job.category_uuid && categoryMap.has(job.category_uuid)) {
                const jobCategory = categoryMap.get(job.category_uuid);
                return jobCategory.allowed_roles.includes(userRole);
            }
            
            // For jobs without categories, apply default role-based rules
            if (userRole === 'Technician Apprentice') {
                // Apprentices only see basic maintenance jobs
                const jobDesc = (job.job_description || '').toLowerCase();
                return jobDesc.includes('basic') || 
                       jobDesc.includes('routine') || 
                       jobDesc.includes('inspection') ||
                       job.status === 'Quote'; // Can see quotes for learning
            } else if (userRole === 'Technician') {
                // Technicians see maintenance and service jobs
                return job.status !== 'Quote' || job.status === 'Work Order' || job.status === 'In Progress';
            } else if (userRole === 'Client Admin' || userRole === 'Client User') {
                // Clients only see their own jobs - this should be handled by client-specific endpoint
                return true; // Allow filtering to be handled by client UUID
            }
            
            // Administrator and Office Manager see all jobs
            return true;
        });
        
        // Apply additional filters if specified
        if (category) {
            jobs = jobs.filter(job => job.category_uuid === category);
        }
        
        if (status) {
            jobs = jobs.filter(job => job.status === status);
        }
          if (type) {
            jobs = jobs.filter(job => {
                if (job.category_uuid && categoryMap.has(job.category_uuid)) {
                    const jobCategory = categoryMap.get(job.category_uuid);
                    return jobCategory.category_type === type;
                }
                // Fallback to description-based type detection
                const jobDesc = (job.job_description || '').toLowerCase();
                if (type === 'maintenance') {
                    return jobDesc.includes('maintenance') || 
                           jobDesc.includes('repair') || 
                           jobDesc.includes('service');
                } else if (type === 'project') {
                    return jobDesc.includes('project') || 
                           jobDesc.includes('installation') || 
                           jobDesc.includes('upgrade');
                }
                return true;
            });
        }

        // Apply site filter if specified
        if (site) {
            jobs = jobs.filter(job => job.location_uuid === site);
        }
        
        // Enhance jobs with category information
        const enhancedJobs = jobs.map(job => {
            let categoryInfo = null;
            if (job.category_uuid && categoryMap.has(job.category_uuid)) {
                categoryInfo = categoryMap.get(job.category_uuid);
            }
            
            return {
                ...job,
                category_info: categoryInfo,
                category_type: categoryInfo ? categoryInfo.category_type : getCategoryType(job.job_description || ''),
                // Ensure consistent field names for frontend
                description: job.job_description || job.description,
                job_description: job.job_description || job.description
            };
        });        console.log(`Filtered ${enhancedJobs.length} jobs for role ${userRole} from ${jobsResponse.data.length} total jobs`);
        
        // Resolve location data for all jobs
        try {
            const jobsWithLocation = await resolveJobLocationData(enhancedJobs);
            res.json({
                jobs: jobsWithLocation,
                total: jobsWithLocation.length,
                role: userRole,
                filters: { category, status, type, site }
            });
        } catch (locationError) {
            console.error('Error resolving location data for role-filtered jobs:', locationError);
            // Return jobs without location data if resolution fails
            res.json({
                jobs: enhancedJobs,
                total: enhancedJobs.length,
                role: userRole,
                filters: { category, status, type, site }
            });
        }
        
    } catch (error) {
        console.error('Error fetching role-filtered jobs:', error);
        res.status(500).json({ 
            error: 'Failed to fetch jobs for role',
            details: error.message 
        });
    }
});

// Get job categories accessible by a specific role
router.get('/jobs/categories/role/:userRole', async (req, res) => {
    try {
        const { userRole } = req.params;
        
        // Get all categories from ServiceM8
        const response = await servicem8.getCategoryAll();
        let categories = response.data.filter(category => category.active === 1);
        
        // Apply role-based filtering
        categories = categories.filter(category => {
            const allowedRoles = getAllowedRoles(category.name);
            return allowedRoles.includes(userRole);
        });
        
        // Enhance categories with type and role information
        const enhancedCategories = categories.map(category => ({
            ...category,
            category_type: getCategoryType(category.name),
            allowed_roles: getAllowedRoles(category.name),
            description: category.description || category.name
        }));
        
        res.json(enhancedCategories);
        
    } catch (error) {
        console.error('Error fetching categories for role:', error);
        res.status(500).json({ 
            error: 'Failed to fetch categories for role',
            details: error.message 
        });
    }
});

// Handle quote acceptance/decline
router.post('/quotes/:quoteId/respond', async (req, res) => {
    try {
        const { quoteId } = req.params;
        const { action, jobUuid } = req.body; // action: 'accept' or 'decline'
        
        if (!action || !['accept', 'decline'].includes(action)) {
            return res.status(400).json({
                error: true,
                message: 'Action must be either "accept" or "decline"'
            });
        }
        
        // Get quote and job details
        const { data: quoteData } = await servicem8.getQuoteSingle({ uuid: quoteId });
        const { data: jobData } = await servicem8.getJobSingle({ uuid: jobUuid || quoteData.job_uuid });
        
        if (!quoteData || !jobData) {
            return res.status(404).json({
                error: true,
                message: 'Quote or job not found'
            });
        }
        
        // Send business workflow notification
        const notificationType = action === 'accept' 
            ? NOTIFICATION_TYPES.QUOTE_ACCEPTED 
            : NOTIFICATION_TYPES.QUOTE_DECLINED;
            
        await sendBusinessNotification(notificationType, {
            jobId: jobData.uuid,
            quoteId: quoteData.uuid,
            jobDescription: jobData.description || jobData.job_description,
            client: jobData.company_name,
            clientUuid: jobData.company_uuid || jobData.created_by_staff_uuid,
            amount: quoteData.amount,
            action: action,
            respondedBy: req.body.userId || 'client-user'
        });
        
        res.json({
            success: true,
            message: `Quote ${action}ed successfully`,
            data: { quoteId, action }
        });
        
    } catch (error) {
        console.error(`Error ${req.body.action}ing quote:`, error);
        res.status(500).json({
            error: true,
            message: `Failed to ${req.body.action} quote`,
            details: error.message
        });
    }
});

// Helper functions for category and role management
function getCategoryType(categoryName) {
    const name = (categoryName || '').toLowerCase();
    if (name.includes('maintenance') || name.includes('repair') || name.includes('service')) {
        return 'maintenance';
    } else if (name.includes('project') || name.includes('installation') || name.includes('upgrade')) {
        return 'project';
    }
    return 'general';
}

function getAllowedRoles(categoryName) {
    const name = (categoryName || '').toLowerCase();
    
    if (name.includes('basic') || name.includes('routine') || name.includes('inspection')) {
        // Basic categories - all roles can access
        return ['Administrator', 'Office Manager', 'Technician', 'Technician Apprentice'];
    } else if (name.includes('advanced') || name.includes('complex') || name.includes('specialized')) {
        // Advanced categories - only experienced roles
        return ['Administrator', 'Office Manager', 'Technician'];
    } else if (name.includes('project') || name.includes('installation')) {
        // Project categories - admin and managers primarily
        return ['Administrator', 'Office Manager', 'Client Admin'];
    } else if (name.includes('domestic') || name.includes('commercial') || name.includes('maintenance') || 
               name.includes('repair') || name.includes('air-conditioning') || name.includes('construction') || 
               name.includes('real estate') || name.includes('warranty') || name.includes('insurance') || 
               name.includes('solar') || name.includes('lighting') || name.includes('digital') || 
               name.includes('strata') || name.includes('uncategorized')) {
        // Client-accessible service categories
        return ['Administrator', 'Office Manager', 'Technician', 'Technician Apprentice', 'Client Admin', 'Client User'];
    }
    
    // Default - most roles can access (excluding clients for security)
    return ['Administrator', 'Office Manager', 'Technician'];
}

module.exports = router;