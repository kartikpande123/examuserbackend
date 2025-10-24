const express = require("express");
const cors = require("cors");
const multer = require("multer");
const admin = require("./db/firebaseConfig").firebaseAdmin;
const Razorpay = require("razorpay");
const axios = require('axios');
const crypto = require('node:crypto');
const moment = require("moment")
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');


// Initialize Express app
const app = express();
const port = 2025;

// Middleware
app.use(express.json());
app.use(cors({
  origin: '*', // or better: "http://localhost:3000" for local testing
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Cache-Control']
}));


// Firestore setup
const firestore = admin.firestore();
const realtimeDatabase = admin.database();
const bucket = admin.storage().bucket();

// Multer setup for image upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // Limit: 5 MB for file size
});


// Multer setup for file uploads
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // Limit: 100 MB
  fileFilter: (req, file, cb) => {
    // Accept only PDF files
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

const videoUpload = multer({ storage: multer.memoryStorage() });



 // API to get all notifications
  app.get("/api/notifications", async (req, res) => {
    try {
      // Reference to the notifications in Realtime Database
      const notificationsRef = realtimeDatabase.ref('Notifications');
      
      // Get the data
      const snapshot = await notificationsRef.once('value');
      const notifications = snapshot.val();
  
      if (!notifications) {
        return res.json({ notifications: [] });
      }
  
      // Convert the object to an array and sort by createdAt
      const notificationArray = Object.entries(notifications).map(([id, data]) => ({
        id,
        ...data
      })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
      res.status(200).json({
        notifications: notificationArray
      });
  
    } catch (error) {
      console.error("Error fetching notifications:", error);
      res.status(500).json({ 
        error: "Failed to fetch notifications",
        details: error.message 
      });
    }
  });

  // API to submit a concern with an image
app.post("/api/concern", upload.single("photo"), async (req, res) => {
  const { concern } = req.body;
  const photo = req.file; // Uploaded image

  try {
      // Validate input
      if (!concern) {
          return res.status(400).json({ error: "Concern text is required" });
      }

      // Prepare concern data
      const concernData = {
          concernText: concern,
          createdAt: new Date().toISOString(),
          photoUrl: null,
      };

      // Handle image (if present)
      if (photo) {
          // Convert image to Base64
          const base64Image = photo.buffer.toString("base64");
          const mimeType = photo.mimetype; // e.g., "image/jpeg" or "image/png"

          concernData.photoUrl = `data:${mimeType};base64,${base64Image}`; // Store as a Data URL
      }

      // Firestore reference for concerns collection
      const concernsRef = firestore.collection("concerns");

      // Add the concern to Firestore
      await concernsRef.add(concernData);

      res.status(201).json({
          message: "Concern submitted successfully",
          concernData,
      });
  } catch (error) {
      console.error("Error submitting concern:", error);
      res.status(500).json({
          error: "Failed to submit concern",
          details: error.message,
      });
  }
});

//exam apis
// Add this endpoint to your existing Express app
app.get("/api/exams", async (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const realtimeDatabase = admin.database(); // Realtime Database reference

  // Helper function to send data to the client
  const sendData = async () => {
    try {
      const examsRef = realtimeDatabase.ref("ExamDateTime");
      const examsSnapshot = await examsRef.once("value");

      const exams = [];

      // Fetch each exam and its subcollections
      examsSnapshot.forEach(examSnap => {
        const examId = examSnap.key;
        const examData = examSnap.val();

        const examDetails = examData.examDetails || {};
        const questions = examData.questions || [];

        exams.push({
          id: examId,
          ...examData,
          examDetails,
          questions: Object.entries(questions).map(([id, data]) => ({ id, ...data }))
        });
      });

      // Send the data to the client
      res.write(`data: ${JSON.stringify({
        success: true,
        data: exams
      })}\n\n`);
    } catch (error) {
      console.error("Error fetching exams:", error);
      res.write(`data: ${JSON.stringify({
        success: false,
        error: "Failed to fetch exams",
        details: error.message
      })}\n\n`);
    }
  };

  // Send initial data
  await sendData();

  // Set up real-time listeners
  const examsRef = realtimeDatabase.ref("Exams");
  const onUpdate = async (snapshot) => {
    await sendData();
  };

  examsRef.on("value", onUpdate, (error) => {
    console.error("Real-time update failed:", error);
    res.write(`data: ${JSON.stringify({
      success: false,
      error: "Real-time update failed",
      details: error.message
    })}\n\n`);
  });

  // Clean up when client disconnects
  req.on('close', () => {
    examsRef.off("value", onUpdate);
  });
});


//user regerster api
// Backend API (Node.js)
app.post('/api/register', upload.single('photo'), async (req, res) => {
  try {
    // Validate all required fields
    const requiredFields = [
      'candidateName', 'gender', 'dob', 'district', 
      'pincode', 'state', 'phone', 'exam',
      'examDate', 'examStartTime', 'examEndTime'
    ];
    
    // Check for missing fields
    const missingFields = requiredFields.filter(field => !req.body[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing required fields: ${missingFields.join(', ')}`
      });
    }
    
    // Validate photo
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No photo file received'
      });
    }
    
    // Process image with Sharp
    const processedImage = await sharp(req.file.buffer)
      .resize({
        width: 300,   // Resize to a standard width
        height: 400,  // Maintain aspect ratio
        fit: 'cover'  // Crop to fit
      })
      .toFormat('jpeg')  // Standardize to JPEG
      .jpeg({ quality: 80 })  // Compress with 80% quality
      .toBuffer();
    
    // Generate unique registration number
    const uniqueRegisterNo = `REG${Date.now()}`;
    
    // Convert processed photo to base64
    const base64Image = processedImage.toString('base64');
    const photoUrl = `data:image/jpeg;base64,${base64Image}`;
    
    // Extract payment details if available
    const paymentDetails = {
      paymentId: req.body.paymentId || null,
      orderId: req.body.orderId || null,
      paymentAmount: req.body.paymentAmount || req.body.examPrice || null,
      paymentDate: req.body.paymentDate || new Date().toISOString()
    };
    
    // Prepare full candidate data
    const candidateData = {
      candidateName: req.body.candidateName,
      gender: req.body.gender,
      dob: req.body.dob,
      district: req.body.district,
      pincode: req.body.pincode,
      state: req.body.state,
      email: req.body.email || '',
      phone: req.body.phone,
      exam: req.body.exam,
      examDate: req.body.examDate,
      examStartTime: req.body.examStartTime,
      examEndTime: req.body.examEndTime,
      photoUrl,
      registrationNumber: uniqueRegisterNo,
      photoSize: processedImage.length,
      createdAt: new Date().toISOString(),
      used: false,
      // Add payment details to the candidate data
      payment: {
        ...paymentDetails,
        status: 'completed'
      }
    };
    
    // Firestore document size limit is ~1MB
    // Check image size before saving
    if (processedImage.length > 1 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        error: 'Processed image still too large'
      });
    }
    
    // Save to Firestore
    const candidateRef = firestore.collection('candidates').doc(uniqueRegisterNo);
    await candidateRef.set(candidateData);
    
    // Also save payment record separately for reporting purposes
    if (paymentDetails.paymentId) {
      const paymentRef = firestore.collection('payments').doc(paymentDetails.paymentId);
      await paymentRef.set({
        orderId: paymentDetails.orderId,
        amount: paymentDetails.paymentAmount,
        date: paymentDetails.paymentDate,
        candidateName: req.body.candidateName,
        candidateEmail: req.body.email || '',
        candidatePhone: req.body.phone,
        exam: req.body.exam,
        registrationNumber: uniqueRegisterNo,
        status: 'completed',
        createdAt: new Date().toISOString()
      });
    }
    
    // Send success response
    res.status(201).json({
      success: true,
      message: 'Candidate registered successfully',
      data: {
        registrationNumber: uniqueRegisterNo,
        ...candidateData
      }
    });
   
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to register candidate'
    });
  }
});

//User reg number api
app.get('/api/candidates', async (req, res) => {
  try {
    // Fetch all candidate documents from the 'candidates' collection
    const snapshot = await firestore.collection('candidates').get();

    if (snapshot.empty) {
      return res.status(404).json({ message: 'No candidates found' });
    }

    // Map through the documents and return the candidate data
    const candidates = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ message: 'Candidates fetched successfully', candidates });
  } catch (error) {
    console.error('Error fetching candidates:', error);
    res.status(500).json({ error: 'Failed to fetch candidates' });
  }
});


//exam apis
// Assuming you are using Express.js

// app.get('/api/exam-question/:examName', (req, res) => {
//   const { examName } = req.params;

//   // Here you'd fetch the question from your database
//   // For the sake of the example, we're using a hardcoded question
//   const question = {
//     text: 'What is 2 + 2?',
//     options: ['A. 3', 'B. 4', 'C. 5', 'D. 6'],
//   };

//   res.json({ question });
// });



// Get Exam Questions Route
app.post('/api/validate-registration', async (req, res) => {
  const { registrationNumber } = req.body;

  try {
    const candidateRef = firestore.collection('candidates').doc(registrationNumber);
    const candidateDoc = await candidateRef.get();

    // Check if registration number exists
    if (!candidateDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Invalid registration number'
      });
    }

    const candidateData = candidateDoc.data();
    const currentDate = new Date();
    const examDate = new Date(candidateData.examDate);

    // Check if exam date is in the past
    if (examDate > currentDate) {
      return res.status(400).json({
        success: false,
        error: 'This registration number is for an upcoming exam and cannot be used yet'
      });
    }

    // Check if the exam has already been used
    if (candidateData.used) {
      return res.status(400).json({
        success: false,
        error: 'This registration number has already been used',
        used: true
      });
    }

    // Validate required fields
    const requiredFields = [
      'candidateName',
      'district',
      'dob',
      'exam',
      'examDate',
      'examStartTime',
      'examEndTime',
      'gender',
      'phone'
    ];

    const missingFields = requiredFields.filter(field => !candidateData[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing required fields: ${missingFields.join(', ')}`
      });
    }

    // If all validations pass, return success with candidate data
    res.status(200).json({
      success: true,
      examName: candidateData.exam,
      candidateName: candidateData.candidateName,
      district: candidateData.district,
      examDate: candidateData.examDate,
      examStartTime: candidateData.examStartTime,
      examEndTime: candidateData.examEndTime,
      used: false
    });

  } catch (error) {
    console.error('Validation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to validate registration'
    });
  }
});

// Start Exam Route
app.post('/api/start-exam', async (req, res) => {
  const { registrationNumber } = req.body;

  try {
    const candidateRef = firestore.collection('candidates').doc(registrationNumber);
    
    // Update the used status
    await candidateRef.update({
      used: true,
      examStartTime: new Date().toISOString()
    });

    res.status(200).json({
      success: true,
      message: 'Exam started successfully'
    });

  } catch (error) {
    console.error('Start exam error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start exam'
    });
  }
});

// Get Exam Questions Route
app.post('/api/exam-questions', async (req, res) => {
  try {
    const { date, examName } = req.body;

    // Reference to the exam document
    const examRef = firestore.collection('Exams').doc(examName);
    const examDoc = await examRef.get();

    if (!examDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Exam not found'
      });
    }

    const examData = examDoc.data();

    // Reference to the questions subcollection
    const questionsRef = examRef.collection('Questions');
    const questionsSnapshot = await questionsRef.get();

    let questions = [];

    // Push questions into the array
    questionsSnapshot.forEach(doc => {
      questions.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // Sort questions by the 'order' field
    questions.sort((a, b) => a.order - b.order);

    res.status(200).json({
      success: true,
      data: {
        examDetails: examData,
        questions: questions
      }
    });

  } catch (error) {
    console.error('Error fetching exam questions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch exam questions'
    });
  }
});

app.post('/api/save-all-answers', async (req, res) => {
  try {
    const { answers } = req.body;
    
    // Validate request body
    if (!Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid answers format. Expected non-empty array.'
      });
    }

    // Create a batch write
    const batch = firestore.batch();

    // Process each answer in the array
    answers.forEach(({ registrationNumber, questionId, answer, examName, skipped, order }) => {
      // Format questionId to ensure Q prefix
      const formattedQuestionId = questionId.startsWith('Q') ? questionId : `Q${questionId}`;

      // Reference to candidate's answer document
      const answerDocRef = firestore
        .collection('candidates')
        .doc(registrationNumber)
        .collection('answers')
        .doc(formattedQuestionId);

      // Prepare the answer data
      let answerData = {
        examName,
        timestamp: new Date().toISOString(),
        order
      };

      if (skipped) {
        // If question is skipped, store with null answer and skipped flag
        answerData = {
          ...answerData,
          answer: null,
          skipped: true
        };
      } else {
        // If question is answered, store answer as integer and skipped as false
        answerData = {
          ...answerData,
          answer: parseInt(answer), // Convert answer to integer
          skipped: false
        };
      }

      // Set the data for this answer
      batch.set(answerDocRef, answerData);
    });

    // Commit the batch
    await batch.commit();

    res.status(200).json({
      success: true,
      message: 'All answers saved successfully'
    });

  } catch (error) {
    console.error('Error saving answers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save answers',
      details: error.message
    });
  }
});


// Complete Exam endpoint - handles both answer submission and completion status
app.post('/api/complete-exam', async (req, res) => {
  try {
    const { candidateId, examName, answers, submitted } = req.body;

    // Validate request
    if (!candidateId || !examName || !Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields or invalid answers format'
      });
    }

    // Create a batch write for atomic operations
    const batch = firestore.batch();

    // Reference to the candidate document
    const candidateRef = firestore.collection('candidates').doc(candidateId);

    // Update candidate's submission status
    batch.update(candidateRef, {
      submitted: true,
      examCompletedAt: new Date().toISOString()
    });

    // Process each answer
    answers.forEach(({ questionId, answer, order, skipped }) => {
      const formattedQuestionId = questionId.startsWith('Q') ? questionId : `Q${questionId}`;
      
      const answerDocRef = candidateRef
        .collection('answers')
        .doc(formattedQuestionId);

      batch.set(answerDocRef, {
        examName,
        timestamp: new Date().toISOString(),
        order,
        answer: skipped ? null : parseInt(answer),
        skipped: skipped || false,
        submittedVia: 'completion'
      });
    });

    // Commit all operations atomically
    await batch.commit();

    // Clear examination data from localStorage (this will be handled client-side)
    res.status(200).json({
      success: true,
      message: 'Exam completed and answers submitted successfully',
      metadata: {
        candidateId,
        examName,
        submittedAt: new Date().toISOString(),
        totalAnswers: answers.length,
        skippedCount: answers.filter(a => a.skipped).length
      }
    });

  } catch (error) {
    console.error('Error completing exam:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to complete exam',
      details: error.message
    });
  }
});





//Syllabus get api
app.get("/api/syllabus", async (req, res) => {
  try {
    const syllabusRef = admin.database().ref("Syllabus");
    const snapshot = await syllabusRef.once("value");

    if (!snapshot.exists()) {
      return res.status(200).json({
        message: "No syllabus found",
        data: {},
        version: "3.11.174"
      });
    }

    const syllabusData = snapshot.val();

    res.status(200).json({
      message: "Syllabus fetched successfully",
      data: syllabusData,
      version: "3.11.174"
    });

  } catch (error) {
    console.error("Error fetching syllabus:", error);
    res.status(500).json({
      error: "Failed to fetch syllabus",
      details: error.message
    });
  }
});


//Api Halltivket 
// API to fetch the latest candidate created
app.get('/api/latest-candidate', async (req, res) => {
  try {
    // Query the 'candidates' collection, ordered by 'createdAt' descending
    const snapshot = await firestore
      .collection('candidates')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ message: 'No candidates found' });
    }

    // Get the latest candidate document
    const latestCandidateDoc = snapshot.docs[0];
    const latestCandidate = {
      id: latestCandidateDoc.id,
      ...latestCandidateDoc.data(),
    };

    res.status(200).json({
      message: 'Latest candidate fetched successfully',
      candidate: latestCandidate,
    });
  } catch (error) {
    console.error('Error fetching the latest candidate:', error);
    res.status(500).json({ error: 'Failed to fetch the latest candidate' });
  }
});

app.get('/api/candidate/:regId', async (req, res) => {
  try {
    const regId = req.params.regId;
    // Use firestore instead of db since it's already defined in your server
    const candidateRef = firestore.collection('candidates');
    // Search by registrationNumber instead of id
    const snapshot = await candidateRef.where('registrationNumber', '==', regId).get();

    if (snapshot.empty) {
      return res.status(404).json({ message: 'Candidate not found' });
    }

    const candidateData = snapshot.docs[0].data();
    res.json({ message: 'Candidate found successfully', candidate: candidateData });
  } catch (error) {
    console.error('Error fetching candidate:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});


//Api for question answer upload
app.get("/api/exam-qa", async (req, res) => {
  try {
    const qaRef = admin.database().ref("ExamQA");
    const snapshot = await qaRef.once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({
        message: "No Q&A data found",
      });
    }

    const data = snapshot.val();
    res.status(200).json({
      message: "Q&A data retrieved successfully",
      data: data,
    });
  } catch (error) {
    console.error("Error fetching Q&A data:", error);
    res.status(500).json({
      message: "Failed to fetch Q&A data",
      error: error.message,
    });
  }
});


// Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

app.post("/api/create-order", async (req, res) => {
  try {
    const { amount, currency = "INR", notes } = req.body;

    if (!amount || isNaN(amount)) {
      return res.status(400).json({ 
        success: false, 
        error: "Invalid amount" 
      });
    }

    // Create Razorpay order
    const options = {
      amount: Math.round(amount * 100), // amount in paisa
      currency,
      receipt: `rcpt_${Date.now()}`,
      notes: notes || {},
      payment_capture: 1 // Auto capture payment
    };

    const order = await razorpay.orders.create(options);

    res.status(201).json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt
      }
    });
  } catch (error) {
    console.error("Error creating payment order:", error);
    res.status(500).json({ 
      success: false, 
      error: "Payment order creation failed" 
    });
  }
});

// Verify payment API
app.post("/api/verify-payment", async (req, res) => {
  try {
    const { orderId, paymentId, signature } = req.body;

    // Debug logging
    console.log('Received payment verification request:', {
      orderId,
      paymentId,
      signature
    });

    // Validate required parameters
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameters",
        required: ['orderId', 'paymentId', 'signature']
      });
    }

    // Create signature verification data
    const text = orderId + "|" + paymentId;
    
    // Verify signature using properly imported crypto
    let generated_signature;
    try {
      generated_signature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(text)
        .digest("hex");
      
      console.log('Generated signature:', generated_signature);
      console.log('Received signature:', signature);
    } catch (cryptoError) {
      console.error('Crypto operation failed:', cryptoError);
      return res.status(500).json({
        success: false,
        error: "Signature generation failed",
        details: cryptoError.message
      });
    }

    // Compare signatures
    if (generated_signature !== signature) {
      return res.status(400).json({
        success: false,
        error: "Invalid payment signature"
      });
    }

    try {
      // Fetch payment details
      const payment = await razorpay.payments.fetch(paymentId);
      console.log('Payment details:', payment);

      // Fetch order details
      const order = await razorpay.orders.fetch(orderId);
      console.log('Order details:', order);

      // Verify payment matches order
      if (payment.order_id !== orderId) {
        throw new Error("Payment order ID mismatch");
      }

      if (payment.amount !== order.amount) {
        throw new Error("Payment amount mismatch");
      }

      // Verify payment status
      if (payment.status !== 'captured') {
        return res.status(400).json({
          success: false,
          error: "Payment not captured",
          status: payment.status
        });
      }

      // Success response
      return res.json({
        success: true,
        payment: {
          orderId,
          paymentId,
          amount: payment.amount / 100,
          status: payment.status,
          method: payment.method,
          email: payment.email,
          contact: payment.contact,
          createdAt: payment.created_at
        }
      });

    } catch (paymentError) {
      console.error("Payment fetch error:", paymentError);
      return res.status(400).json({
        success: false,
        error: "Invalid payment details",
        details: paymentError.message
      });
    }

  } catch (error) {
    console.error("Payment verification error:", error);
    return res.status(500).json({
      success: false,
      error: "Payment verification failed",
      details: error.message
    });
  }
});

// Frontend payment handling function

//doubt
app.get("/getExamSubDetails", async (req, res) => {
  try {
    const db = admin.database();
    const examRef = db.ref("ExamDateTime");

    // Fetch all exams from Realtime Database
    const examsSnapshot = await examRef.once("value");
    if (!examsSnapshot.exists()) {
      return res.status(404).json({ error: "No exams found" });
    }

    const examsData = examsSnapshot.val();
    const allExams = [];

    // Loop through each exam
    for (const [examId, examData] of Object.entries(examsData)) {
      const detailsRef = examRef.child(`${examId}/details`);
      const detailsSnapshot = await detailsRef.once("value");

      const details = [];
      if (detailsSnapshot.exists()) {
        const detailsData = detailsSnapshot.val();
        for (const [detailId, detailData] of Object.entries(detailsData)) {
          details.push({ id: detailId, ...detailData });
        }
      }

      allExams.push({
        examId,
        examData,
        details,
      });
    }

    return res.json({ exams: allExams });
  } catch (error) {
    console.error("Error fetching all exam details:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


//for main exam timing api
app.get("/api/today-exams", (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Helper function to fetch and send exam data
  const sendExamData = async () => {
    try {
      const today = moment().format('YYYY-MM-DD');
      const examRef = realtimeDatabase.ref('ExamDateTime');
      const snapshot = await examRef.once('value');
      const allExams = snapshot.val();

      const todayExams = Object.entries(allExams || {})
        .filter(([_, exam]) => exam.date === today)
        .map(([id, exam]) => ({
          id,
          date: exam.date,
          startTime: exam.startTime,
          endTime: exam.endTime,
          marks: exam.marks,
          price: exam.price,
          updatedAt: exam.updatedAt
        }))
        .sort((a, b) => moment(a.startTime, 'hh:mm A').diff(moment(b.startTime, 'hh:mm A')));

      res.write(`data: ${JSON.stringify({
        success: true,
        data: todayExams
      })}\n\n`);
    } catch (error) {
      res.write(`data: ${JSON.stringify({
        success: false,
        error: 'Failed to fetch exam data',
        details: error.message
      })}\n\n`);
    }
  };

  // Send initial data
  sendExamData();

  // Set up real-time listener
  const examRef = realtimeDatabase.ref('ExamDateTime');
  const handleUpdate = async () => {
    await sendExamData();
  };

  examRef.on('value', handleUpdate);

  // Cleanup on client disconnect
  req.on('close', () => {
    examRef.off('value', handleUpdate);
  });
});

app.post('/api/timeout-save-answers', async (req, res) => {
  try {
    const { answers } = req.body;

    // Validate request
    if (!Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid answers format'
      });
    }

    // Filter only attempted questions
    const attemptedAnswers = answers.filter(answer => 
      !answer.skipped && answer.answer !== null && answer.answer !== undefined
    );

    if (attemptedAnswers.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No attempted answers to save'
      });
    }

    const batch = firestore.batch();

    attemptedAnswers.forEach(({ registrationNumber, questionId, answer, examName, order }) => {
      const formattedQuestionId = questionId.startsWith('Q') ? questionId : `Q${questionId}`;
      
      const answerDocRef = firestore
        .collection('candidates')
        .doc(registrationNumber)
        .collection('answers')
        .doc(formattedQuestionId);

      batch.set(answerDocRef, {
        examName,
        timestamp: new Date().toISOString(),
        order,
        answer: parseInt(answer),
        skipped: false,
        submittedVia: 'timeout'
      });
    });

    await batch.commit();

    res.status(200).json({
      success: true,
      message: 'Attempted answers saved successfully',
      savedCount: attemptedAnswers.length
    });

  } catch (error) {
    console.error('Error saving timeout answers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save answers',
      details: error.message
    });
  }
});


app.post('/api/save-answer', async (req, res) => {
  try {
    const { registrationNumber, questionId, answer, examName, order, skipped } = req.body;

    // Validate request
    if (!registrationNumber || !questionId || answer === undefined || !examName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    const formattedQuestionId = questionId.startsWith('Q') ? questionId : `Q${questionId}`;
    
    const answerDocRef = firestore
      .collection('candidates')
      .doc(registrationNumber)
      .collection('answers')
      .doc(formattedQuestionId);

    await answerDocRef.set({
      examName,
      timestamp: new Date().toISOString(),
      order,
      answer: parseInt(answer),
      skipped: skipped || false,
      submittedVia: 'individual'
    });

    res.status(200).json({
      success: true,
      message: 'Answer saved successfully'
    });
  } catch (error) {
    console.error('Error saving answer:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save answer',
      details: error.message
    });
  }
});


//Results Api
// Add this new API endpoint to your existing Express app
app.get("/api/today-exam-results", async (req, res) => {
  try {
    const today = moment().format('YYYY-MM-DD');
    
    // Step 1: Get today's exam from Firestore
    const examsSnapshot = await firestore.collection('Exams').get();
    let todayExam = null;
    let examQuestions = [];

    // Find today's exam
    for (const doc of examsSnapshot.docs) {
      const examData = doc.data();
      if (examData.dateTime?.date === today) {
        todayExam = {
          id: doc.id,
          ...examData.dateTime
        };
        
        // Get questions for this exam
        const questionsSnapshot = await doc.ref.collection('Questions').orderBy('order').get();
        examQuestions = questionsSnapshot.docs.map(qDoc => ({
          id: qDoc.id,
          ...qDoc.data()
        }));
        break;
      }
    }

    if (!todayExam) {
      return res.status(404).json({
        success: false,
        message: 'No exam found for today'
      });
    }

    // Step 2: Get candidates who took this exam
    const candidatesSnapshot = await firestore.collection('candidates')
      .where('exam', '==', todayExam.id)
      .get();

    const results = [];
    
    // Step 3: Process each candidate's answers
    for (const candidateDoc of candidatesSnapshot.docs) {
      const candidateData = candidateDoc.data();
      
      // Get candidate's answers
      const answersSnapshot = await candidateDoc.ref.collection('answers').get();
      const answers = answersSnapshot.docs.map(aDoc => ({
        id: aDoc.id,
        ...aDoc.data()
      }));

      // Calculate results
      let correctAnswers = 0;
      let skippedQuestions = 0;
      
      examQuestions.forEach(question => {
        const candidateAnswer = answers.find(a => a.order === question.order);
        
        if (!candidateAnswer || candidateAnswer.skipped) {
          skippedQuestions++;
        } else if (candidateAnswer.answer === question.correctAnswer) {
          correctAnswers++;
        }
      });

      // Prepare result object
      const resultData = {
        registrationNumber: candidateDoc.id,
        candidateName: candidateData.candidateName,
        phone: candidateData.phone,
        totalQuestions: examQuestions.length,
        correctAnswers,
        skippedQuestions,
        wrongAnswers: examQuestions.length - (correctAnswers + skippedQuestions)
      };

      results.push(resultData);

      // Store results in Realtime Database
      const resultRef = realtimeDatabase.ref(`Results/${todayExam.id}/${candidateDoc.id}`);
      await resultRef.set({
        ...resultData,
        timestamp: new Date().toISOString()
      });
    }

    res.status(200).json({
      success: true,
      examDetails: {
        examName: todayExam.id,
        date: todayExam.date,
        startTime: todayExam.startTime,
        endTime: todayExam.endTime,
        totalMarks: todayExam.marks
      },
      results
    });

  } catch (error) {
    console.error('Error fetching exam results:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch exam results',
      details: error.message
    });
  }
});


// API to get all exam results
app.get("/api/all-exam-results", async (req, res) => {
  try {
    // Reference to the Results node in Realtime Database
    const resultsRef = realtimeDatabase.ref('Results');
    
    // Fetch all results
    const snapshot = await resultsRef.once('value');
    const resultsData = snapshot.val();

    // If no results exist
    if (!resultsData) {
      return res.status(200).json({
        success: true,
        message: "No exam results found",
        data: {}
      });
    }

    // Transform the data into a more structured format
    const formattedResults = Object.entries(resultsData).map(([examId, examData]) => ({
      examId,
      candidates: Object.entries(examData).map(([registrationId, candidateData]) => ({
        registrationId,
        ...candidateData
      }))
    }));

    res.status(200).json({
      success: true,
      message: "Exam results fetched successfully",
      data: formattedResults,
      metadata: {
        totalExams: formattedResults.length,
        totalCandidates: formattedResults.reduce((total, exam) => 
          total + exam.candidates.length, 0
        )
      }
    });

  } catch (error) {
    console.error("Error fetching exam results:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch exam results",
      details: error.message
    });
  }
});



//Apis to show user there answers and correct answers
app.get("/api/exams/qa", async (req, res) => { 
  try {
    const examsRef = firestore.collection("Exams");
    const examSnapshot = await examsRef.get();
    
    const exams = [];
    
    // Fetch each exam and its subcollections
    for (const examDoc of examSnapshot.docs) {
      const examData = examDoc.data();
      const examId = examDoc.id;
      
      // Get exam details subcollection
      const examDetailsRef = examsRef.doc(examId);
      const examDetailsSnapshot = await examDetailsRef.get();
      
      // Get questions subcollection
      const questionsRef = examDetailsRef.collection("Questions");
      const questionsSnapshot = await questionsRef.get();
      
      const questions = [];
      questionsSnapshot.forEach(questionDoc => {
        questions.push({
          id: questionDoc.id,
          ...questionDoc.data()
        });
      });

      // Combine all data
      exams.push({
        id: examId,
        ...examData,
        examDetails: examDetailsSnapshot.data(),
        questions: questions
      });
    }
    
    res.status(200).json({
      success: true,
      data: exams
    });
    
  } catch (error) {
    console.error("Error fetching exams:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch exams",
      details: error.message
    });
  }
});

// API to fetch candidate answers by registration ID
app.get('/api/candidate-answers/:registrationId', async (req, res) => {
  try {
    const { registrationId } = req.params;

    // Validate registration ID
    if (!registrationId) {
      return res.status(400).json({
        success: false,
        error: 'Registration ID is required'
      });
    }

    // Reference to the candidate's answers collection
    const answersRef = firestore
      .collection('candidates')
      .doc(registrationId)
      .collection('answers');

    // Fetch all answers for the candidate
    const answersSnapshot = await answersRef.orderBy('order').get();

    if (answersSnapshot.empty) {
      return res.status(404).json({
        success: false,
        message: 'No answers found for this registration ID'
      });
    }

    // Format the answers data
    const answers = answersSnapshot.docs.map(doc => ({
      questionId: doc.id,
      ...doc.data(),
      // Ensure consistent data types
      answer: typeof doc.data().answer === 'number' ? doc.data().answer : null,
      order: Number(doc.data().order),
      skipped: Boolean(doc.data().skipped)
    }));

    // Get candidate details
    const candidateRef = firestore.collection('candidates').doc(registrationId);
    const candidateDoc = await candidateRef.get();
    
    if (!candidateDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Candidate not found'
      });
    }

    const candidateData = candidateDoc.data();

    // Prepare response
    const response = {
      success: true,
      data: {
        registrationId,
        candidateDetails: {
          name: candidateData.candidateName,
          exam: candidateData.exam,
          examDate: candidateData.examDate,
          examCompletedAt: candidateData.examCompletedAt
        },
        answers: answers,
        metadata: {
          totalAnswers: answers.length,
          skippedCount: answers.filter(a => a.skipped).length,
          submittedAnswers: answers.filter(a => !a.skipped).length
        }
      }
    };

    res.status(200).json(response);

  } catch (error) {
    console.error('Error fetching candidate answers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch candidate answers',
      details: error.message
    });
  }
});


//Winners store api 
// Add this route to your index.js or appropriate router file

app.post('/api/save-winner-choice', async (req, res) => {
  try {
    const {
      examTitle,
      registrationNumber,
      rank,
      selectedOption
    } = req.body;

    // Validate required fields
    if (!examTitle || !registrationNumber || !rank || !selectedOption) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields. Please provide examTitle, registrationNumber, rank, and selectedOption'
      });
    }

    // Validate selectedOption
    if (!['product', 'cash'].includes(selectedOption)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid selectedOption. Must be either "product" or "cash"'
      });
    }

    // Get current date in DD/MM/YYYY format (for data field only)
    const today = new Date();
    const currentDate = `${today.getDate().toString().padStart(2, '0')}/${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getFullYear()}`;

    // New structure: Winners/{examTitle}/{registrationNumber}
    const winnerRef = realtimeDatabase.ref(`Winners/${examTitle}/${registrationNumber}`);

    // Check if entry already exists
    const snapshot = await winnerRef.once('value');
    if (snapshot.exists()) {
      return res.status(409).json({
        success: false,
        error: 'Winner choice already recorded for this registration number'
      });
    }

    // Prepare winner details
    const winnerData = {
      registrationNumber,
      examTitle,
      rank,
      selectedOption,
      status: 'pending',
      dateCreated: currentDate
    };

    // Get candidate details from Realtime Database
    const candidateRef = realtimeDatabase.ref(`candidates/${registrationNumber}`);
    const candidateSnapshot = await candidateRef.once('value');

    if (candidateSnapshot.exists()) {
      const candidateData = candidateSnapshot.val();
      winnerData.candidateDetails = {
        name: candidateData.candidateName,
        exam: candidateData.exam,
        examDate: candidateData.examDate
      };
    }

    // Save winner details
    await winnerRef.set(winnerData);

    // Prepare response
    const response = {
      success: true,
      data: {
        message: 'Winner choice saved successfully',
        details: {
          examTitle,
          registrationNumber,
          rank,
          selectedOption,
          dateRecorded: currentDate,
          ...(winnerData.candidateDetails || {})
        }
      }
    };

    res.status(200).json(response);

  } catch (error) {
    console.error('Error saving winner choice:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save winner choice',
      details: error.message
    });
  }
});


app.get('/api/winners', async (req, res) => {
  try {
    // Reference to Winners collection
    const winnersRef = realtimeDatabase.ref('Winners');
    
    // Get all data from Winners node
    const snapshot = await winnersRef.once('value');
    const winnersData = snapshot.val();
    
    // If no data exists
    if (!winnersData) {
      return res.status(404).json({
        success: false,
        error: 'No winners data found'
      });
    }
    
    // Transform data into a more organized structure
    const formattedData = {};
    
    // Iterate through exam titles
    Object.entries(winnersData).forEach(([examTitle, examData]) => {
      formattedData[examTitle] = [];
      
      // Iterate through registrations under each exam
      Object.entries(examData).forEach(([regNumber, winnerDetails]) => {
        formattedData[examTitle].push({
          registrationNumber: regNumber,
          ...winnerDetails
        });
      });
      
      // Sort winners by rank for each exam
      formattedData[examTitle].sort((a, b) => a.rank - b.rank);
    });
    
    // Prepare response
    const response = {
      success: true,
      data: {
        message: 'Winners data retrieved successfully',
        winners: formattedData
      }
    };
    
    res.status(200).json(response);
    
  } catch (error) {
    console.error('Error retrieving winners data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve winners data',
      details: error.message
    });
  }
});



//Ptactice test apis

const practiceTestsRef = realtimeDatabase.ref('PracticeTests');

app.get("/api/practice-tests", async (req, res) => {
  try {
    const snapshot = await practiceTestsRef.once('value');
    const practiceTests = {};

    snapshot.forEach((categorySnapshot) => {
      const category = categorySnapshot.key;
      practiceTests[category] = {};

      categorySnapshot.forEach((titleSnapshot) => {
        practiceTests[category][titleSnapshot.key] = titleSnapshot.val();
      });
    });

    res.json(practiceTests);
  } catch (error) {
    console.error("Error fetching practice tests:", error);
    res.status(500).json({ error: "Failed to fetch practice tests" });
  }
});


app.get("/api/practice-tests/:category", async (req, res) => {
  try {
    const { category } = req.params;
    const categoryRef = practiceTestsRef.child(category);

    const snapshot = await categoryRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Category not found" });
    }

    res.json(snapshot.val());
  } catch (error) {
    console.error("Error fetching category practice tests:", error);
    res.status(500).json({ error: "Failed to fetch category practice tests" });
  }
});


//Razorpay apis 
// Create Razorpay Order API
app.post("/api/create-order", async (req, res) => {
  try {
    const { amount, currency = "INR", notes } = req.body;

    if (!amount || isNaN(amount)) {
      return res.status(400).json({ 
        success: false, 
        error: "Invalid amount" 
      });
    }

    // Create Razorpay order
    const options = {
      amount: Math.round(amount * 100), // amount in paisa
      currency,
      receipt: `rcpt_${Date.now()}`,
      notes: notes || {},
      payment_capture: 1 // Auto capture payment
    };

    const order = await razorpay.orders.create(options);

    res.status(201).json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt
      }
    });
  } catch (error) {
    console.error("Error creating payment order:", error);
    res.status(500).json({ 
      success: false, 
      error: "Payment order creation failed" 
    });
  }
});

// Verify Payment API
app.post("/api/verify-payment", async (req, res) => {
  try {
    const { orderId, paymentId, signature } = req.body;

    // Validate required parameters
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameters",
        required: ['orderId', 'paymentId', 'signature']
      });
    }

    // Create signature verification data
    const text = orderId + "|" + paymentId;
    
    // Verify signature
    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(text)
      .digest("hex");

    // Compare signatures
    if (generated_signature !== signature) {
      return res.status(400).json({
        success: false,
        error: "Invalid payment signature"
      });
    }

    // Fetch payment details
    const payment = await razorpay.payments.fetch(paymentId);
    const order = await razorpay.orders.fetch(orderId);

    // Additional verification checks
    if (payment.order_id !== orderId) {
      return res.status(400).json({
        success: false,
        error: "Payment order ID mismatch"
      });
    }

    if (payment.amount !== order.amount) {
      return res.status(400).json({
        success: false,
        error: "Payment amount mismatch"
      });
    }

    // Verify payment status
    if (payment.status !== 'captured') {
      return res.status(400).json({
        success: false,
        error: "Payment not captured",
        status: payment.status
      });
    }

    // Success response
    return res.json({
      success: true,
      payment: {
        orderId,
        paymentId,
        amount: payment.amount / 100,
        status: payment.status,
        method: payment.method,
        email: payment.email,
        contact: payment.contact,
        createdAt: payment.created_at
      }
    });

  } catch (error) {
    console.error("Payment verification error:", error);
    return res.status(500).json({
      success: false,
      error: "Payment verification failed",
      details: error.message
    });
  }
});

// Save Exam Registration API
// Verify Student ID
// Verify Student Endpoint
app.get("/api/verify-student/:studentId", async (req, res) => {
  try {
    const { studentId } = req.params;
    
    // Search in practicetestpurchasedstudents collection for student details
    const studentSnapshot = await realtimeDatabase
      .ref('practicetestpurchasedstudents')
      .orderByChild('studentId')
      .equalTo(studentId)
      .once('value');
    
    const studentData = studentSnapshot.val();
    
    if (studentData) {
      // Return first matching student data
      const studentKey = Object.keys(studentData)[0];
      res.json({
        exists: true,
        studentDetails: studentData[studentKey]
      });
    } else {
      res.json({
        exists: false,
        message: 'Student not found'
      });
    }
  } catch (error) {
    console.error("Student verification error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to verify student"
    });
  }
});

// Check Exam Purchase Validity
app.get("/api/check-exam-purchase", async (req, res) => {
  try {
    const { studentId, examId } = req.query;
    
    // Search in practicetestpurchasedstudents collection
    const studentSnapshot = await realtimeDatabase
      .ref('practicetestpurchasedstudents')
      .orderByChild('studentId')
      .equalTo(studentId)
      .once('value');
    
    const studentData = studentSnapshot.val();
    
    if (studentData) {
      const studentKey = Object.keys(studentData)[0];
      const student = studentData[studentKey];
      
      // Check if student has purchases
      const purchases = student.purchases || [];
      
      const hasActivePurchase = purchases.some(purchase => {
        // Check exam ID and purchase date (within duration specified in exam details)
        const purchaseDate = new Date(purchase.purchaseDate);
        const examDuration = purchase.examDetails.duration || 1; // default to 1 day if not specified
        
        const expirationDate = new Date(purchaseDate);
        expirationDate.setDate(expirationDate.getDate() + examDuration);
        
        const currentDate = new Date();
        
        return purchase.examDetails.id === examId && 
               currentDate <= expirationDate;
      });
      
      res.json({ 
        purchased: hasActivePurchase 
      });
    } else {
      res.json({ 
        purchased: false 
      });
    }
  } catch (error) {
    console.error("Exam purchase check error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to check exam purchase"
    });
  }
});


// Register New Student or Save Student Exam Details
app.post("/api/register-student", async (req, res) => {
  try {
    const {
      name,
      age,
      gender,
      phoneNo,
      email,
      district,
      state,
      examDetails // Optional exam details
    } = req.body;
    
    // Generate a 6-digit student ID
    const studentId = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Prepare student details
    const studentData = {
      studentId,
      name,
      age,
      gender,
      phoneNo,
      email,
      district,
      state,
      registrationDate: new Date().toISOString(),
      purchases: [] // Initialize empty purchases array
    };
    
    // Add exam details to purchases if provided
    if (examDetails) {
      studentData.purchases.push({
        examDetails,
        purchaseDate: new Date().toISOString()
      });
    }
    
    // Save to Firebase Realtime Database in practicetestpurchasedstudents collection
    const registrationRef = realtimeDatabase.ref('practicetestpurchasedstudents').push();
    await registrationRef.set(studentData);
    
    res.status(201).json({
      success: true,
      message: 'Student registered successfully',
      studentId: studentId
    });
    
  } catch (error) {
    console.error("Student registration error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to register student",
      details: error.message
    });
  }
});

// Save Exam Purchase
app.post("/api/save-exam-purchase", async (req, res) => {
  try {
    const { 
      studentId, 
      examDetails, 
      paymentDetails 
    } = req.body;

    // Find the student
    const studentSnapshot = await realtimeDatabase
      .ref('practicetestpurchasedstudents')
      .orderByChild('studentId')
      .equalTo(studentId)
      .once('value');
    
    const studentData = studentSnapshot.val();
    
    if (!studentData) {
      return res.status(404).json({
        success: false,
        error: "Student not found"
      });
    }

    // Get the student key
    const studentKey = Object.keys(studentData)[0];
    const student = studentData[studentKey];

    // Prepare new purchase
    const newPurchase = {
      examDetails,
      paymentDetails,
      purchaseDate: new Date().toISOString()
    };

    // Add purchase to student's purchases
    if (!student.purchases) {
      student.purchases = [];
    }
    student.purchases.push(newPurchase);

    // Update the student record
    await realtimeDatabase
      .ref(`practicetestpurchasedstudents/${studentKey}`)
      .set(student);

    res.status(201).json({
      success: true,
      message: 'Exam purchase saved successfully',
      purchaseId: student.purchases.length - 1 // Index of the new purchase
    });

  } catch (error) {
    console.error("Exam purchase save error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to save exam purchase",
      details: error.message
    });
  }
});



// Update Student Details API Endpoint
app.put("/api/update-student/:studentId", async (req, res) => {
  try {
    const { studentId } = req.params;
    const {
      name,
      age,
      gender,
      phoneNo,
      email,
      district,
      state,
      examDetails // Optional exam details
    } = req.body;

    // Find the student
    const studentSnapshot = await realtimeDatabase
      .ref('practicetestpurchasedstudents')
      .orderByChild('studentId')
      .equalTo(studentId)
      .once('value');
        
    const studentData = studentSnapshot.val();
        
    if (!studentData) {
      return res.status(404).json({
        success: false,
        error: "Student not found"
      });
    }

    // Get the student key
    const studentKey = Object.keys(studentData)[0];
    const student = studentData[studentKey];

    // Update student details
    const updatedStudentData = {
      ...student,
      name: name || student.name,
      age: age || student.age,
      gender: gender || student.gender,
      phoneNo: phoneNo || student.phoneNo,
      email: email || student.email,
      district: district || student.district,
      state: state || student.state,
      lastUpdated: new Date().toISOString()
    };

    // Add exam details to purchases if provided
    if (examDetails) {
      if (!updatedStudentData.purchases) {
        updatedStudentData.purchases = [];
      }
      updatedStudentData.purchases.push({
        examDetails,
        purchaseDate: new Date().toISOString()
      });
    }

    // Update the student record
    await realtimeDatabase
      .ref(`practicetestpurchasedstudents/${studentKey}`)
      .set(updatedStudentData);

    res.status(200).json({
      success: true,
      message: 'Student details updated successfully',
      studentId: studentId
    });
  } catch (error) {
    console.error("Student update error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update student details",
      details: error.message
    });
  }
});


//Api for practice questions 
// API endpoint to fetch practice exam questions

app.get("/api/practice-tests/:category/:examId/questions", async (req, res) => {
  const { category, examId } = req.params;

  try {
    // Firestore references
    const questionsCollection = firestore.collection("PracticeTests").doc(category)
      .collection("Exams").doc(examId)
      .collection("Questions");

    // Get all questions ordered by the 'order' field
    const questionsSnapshot = await questionsCollection.orderBy("order", "asc").get();

    if (questionsSnapshot.empty) {
      return res.status(200).json({ questions: [] });
    }

    // Transform the snapshot to an array of questions
    const questions = [];
    questionsSnapshot.forEach((doc) => {
      const questionData = doc.data();
      questions.push({
        id: doc.id,
        question: questionData.question,
        options: questionData.options,
        correctAnswer: questionData.correctAnswer,
        imageUrl: questionData.imageUrl || null,
        order: questionData.order
      });
    });

    // Return the questions
    res.status(200).json({ questions });
  } catch (error) {
    console.error("Error fetching questions:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});


// POST API to store exam analytics
app.post("/submit-exam-result", async (req, res) => {
  try {
    const { studentId, examDetails, purchaseDate, correctAnswers, wrongAnswers } = req.body;
    
    if (!studentId || !examDetails) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    // Reference to 'practicetestpurchasedstudents' collection
    const studentsRef = realtimeDatabase.ref("practicetestpurchasedstudents");
    
    // Fetch all users to find matching studentId
    const snapshot = await studentsRef.once("value");
    let userKey = null;
    
    snapshot.forEach((childSnapshot) => {
      const userData = childSnapshot.val();
      if (userData.studentId === studentId) {
        userKey = childSnapshot.key;
      }
    });
    
    if (!userKey) {
      return res.status(404).json({ error: "Student ID not found in database" });
    }
    
    // Format date and time for storing exam results
    const currentDate = new Date();
    const formattedDate = `${currentDate.getDate()}-${currentDate.getMonth() + 1}-${currentDate.getFullYear()}`;
    const formattedTime = `${currentDate.getHours()}:${currentDate.getMinutes()}`;
    
    // Generate a unique key for this attempt using timestamp
    const attemptId = `attempt-${Date.now()}`;
    
    // Reference directly to the exam title under ExamAnalytics, avoiding nested date structure
    const examRef = studentsRef.child(`${userKey}/ExamAnalytics/${examDetails.title}/${attemptId}`);
    
    // Store exam result with date as a field, not as path components
    await examRef.set({
      date: formattedDate,
      time: formattedTime,
      correctAnswers,
      wrongAnswers,
      purchaseDate,
    });
    
    return res.status(200).json({ message: "Exam result stored successfully" });
  } catch (error) {
    console.error("Error storing exam result:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});




//Pdf Syllabus realted apis

// Get all PDF syllabi
const pdfSyllabusRef = realtimeDatabase.ref('pdfsyllabi');


app.get("/api/pdf-syllabi", async (req, res) => {
  try {
    const snapshot = await pdfSyllabusRef.once('value');
    const syllabi = {};
    
    snapshot.forEach((categorySnapshot) => {
      categorySnapshot.forEach((syllabusSnapshot) => {
        const syllabusData = syllabusSnapshot.val();
        const category = syllabusData.category;
        
        if (!syllabi[category]) {
          syllabi[category] = {};
        }
        
        syllabi[category][syllabusData.title] = syllabusData;
      });
    });
    
    res.json(syllabi);
  } catch (error) {
    console.error("Error fetching PDF syllabi:", error);
    res.status(500).json({ error: "Failed to fetch PDF syllabi" });
  }
});

// Get PDF syllabi by category
app.get("/api/pdf-syllabi/category/:category", async (req, res) => {
  try {
    const { category } = req.params;
    const sanitizedCategory = sanitizeFilename(category);
    
    const snapshot = await pdfSyllabusRef.child(sanitizedCategory).once('value');
    const syllabi = {};
    
    snapshot.forEach((syllabusSnapshot) => {
      const syllabusData = syllabusSnapshot.val();
      syllabi[syllabusData.title] = syllabusData;
    });
    
    res.json(syllabi);
  } catch (error) {
    console.error("Error fetching PDF syllabi by category:", error);
    res.status(500).json({ error: "Failed to fetch PDF syllabi by category" });
  }
});


//Pdf user purchase
// Reference to database collections
// Define the new database references
const pdfSyllabusPurchasersRef = realtimeDatabase.ref('pdfsyllabuspurchasers');

// 1. Verify student
app.get('/api/pdf-verify-student/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    
    const studentSnapshot = await pdfSyllabusPurchasersRef.child(studentId).once('value');
    const studentData = studentSnapshot.val();
    
    if (studentData) {
      return res.json({
        exists: true,
        studentDetails: {
          studentId,
          ...studentData
        }
      });
    } else {
      return res.json({
        exists: false
      });
    }
  } catch (error) {
    console.error('Error verifying pdf student:', error);
    return res.status(500).json({
      error: 'Failed to verify pdf student ID',
      message: error.message
    });
  }
});

// 2. Register new student
app.post('/api/pdf-register-student', async (req, res) => {
  try {
    const studentData = req.body;
    
    // Generate a random 6-digit student ID
    let studentId;
    let isUnique = false;
    
    while (!isUnique) {
      // Generate a random 6-digit number
      studentId = Math.floor(100000 + Math.random() * 900000).toString();
      
      // Check if this ID already exists
      const existingStudent = await pdfSyllabusPurchasersRef.child(studentId).once('value');
      if (!existingStudent.exists()) {
        isUnique = true;
      }
    }
    
    // Save student data to Firebase
    await pdfSyllabusPurchasersRef.child(studentId).set({
      name: studentData.name,
      age: studentData.age,
      gender: studentData.gender,
      phoneNo: studentData.phoneNo,
      email: studentData.email || null,
      district: studentData.district,
      state: studentData.state,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });
    
    return res.json({
      success: true,
      message: 'PDF student registered successfully',
      studentId: studentId
    });
  } catch (error) {
    console.error('Error registering pdf student:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to register pdf student',
      message: error.message
    });
  }
});

// 3. Update existing student details
app.put('/api/pdf-update-student/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const updatedData = req.body;
    
    // Check if student exists
    const studentSnapshot = await pdfSyllabusPurchasersRef.child(studentId).once('value');
    
    if (!studentSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        error: 'PDF student not found'
      });
    }
    
    // Update the student data
    await pdfSyllabusPurchasersRef.child(studentId).update({
      name: updatedData.name,
      age: updatedData.age,
      gender: updatedData.gender,
      phoneNo: updatedData.phoneNo,
      email: updatedData.email || null,
      district: updatedData.district,
      state: updatedData.state,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });
    
    // Get the updated student data
    const updatedStudentSnapshot = await pdfSyllabusPurchasersRef.child(studentId).once('value');
    
    return res.json({
      success: true,
      message: 'PDF student details updated successfully',
      studentDetails: {
        studentId,
        ...updatedStudentSnapshot.val()
      }
    });
  } catch (error) {
    console.error('Error updating pdf student:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to update pdf student details',
      message: error.message
    });
  }
});

// 4. Create a new order for PDF purchase
app.post('/api/create-pdf-order', async (req, res) => {
  try {
    const { amount, notes } = req.body;
    
    const options = {
      amount: Math.round(amount * 100), // Amount in paise
      currency: 'INR',
      receipt: `pdf_receipt_${Date.now()}`,
      notes
    };
    
    const order = await razorpay.orders.create(options);
    
    // No longer storing order in a separate collection
    
    return res.json({
      success: true,
      order
    });
  } catch (error) {
    console.error('Error creating pdf order:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to create pdf payment order',
      message: error.message
    });
  }
});

// 5. Verify payment after Razorpay callback
app.post('/api/verify-pdf-payment', async (req, res) => {
  try {
    const {
      orderId,
      paymentId,
      signature,
      syllabusId,
      filePath,
      userId
    } = req.body;
    
    // Verify signature
    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    
    if (generatedSignature !== signature) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pdf payment signature'
      });
    }
    
    // No longer updating order status in a separate collection
    
    // Payment is valid
    return res.json({
      success: true,
      message: 'PDF payment verified successfully',
      paymentId,
      syllabusId,
      userId
    });
  } catch (error) {
    console.error('Error verifying pdf payment:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to verify pdf payment',
      message: error.message
    });
  }
});

// 6. Save syllabus purchase details - UPDATED to use the new structure
app.post('/api/pdf-save-syllabus-purchase', async (req, res) => {
  try {
    const {
      studentId,
      syllabusDetails,
      paymentDetails,
      purchaseDate
    } = req.body;
    
    const purchaseId = uuidv4();
    
    // Create purchase record
    const purchaseData = {
      purchaseId: purchaseId,
      syllabusId: syllabusDetails.id,
      syllabusTitle: syllabusDetails.title,
      syllabusCategory: syllabusDetails.category,
      syllabusPrice: syllabusDetails.price,
      syllabusDuration: syllabusDetails.duration,
      syllabusDescription: syllabusDetails.description || '',
      syllabusFilePath: syllabusDetails.filePath || `syllabi/${syllabusDetails.id}.pdf`,
      paymentStatus: paymentDetails.status,
      paymentAmount: paymentDetails.amount,
      paymentId: paymentDetails.paymentId || null,
      orderId: paymentDetails.orderId || null,
      purchaseDate: purchaseDate,
      expirationDate: syllabusDetails.expirationDate,
      createdAt: admin.database.ServerValue.TIMESTAMP
    };
    
    // Save to Firebase under the student's purchases subcollection
    await pdfSyllabusPurchasersRef.child(studentId).child('purchases').child(purchaseId).set(purchaseData);
    
    return res.json({
      success: true,
      message: 'PDF syllabus purchase saved successfully',
      purchaseId: purchaseId
    });
  } catch (error) {
    console.error('Error saving pdf purchase:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to save pdf syllabus purchase',
      message: error.message
    });
  }
});

// 7. Get student's purchased syllabi - UPDATED to use the new structure
app.get('/api/pdf-student-purchases/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    
    const purchasesSnapshot = await pdfSyllabusPurchasersRef.child(studentId).child('purchases').once('value');
    const purchases = purchasesSnapshot.val() || {};
    
    return res.json({
      success: true,
      purchases: Object.values(purchases)
    });
  } catch (error) {
    console.error('Error fetching pdf student purchases:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch pdf student purchases',
      message: error.message
    });
  }
});




//Pdf syllabus show apis
// Endpoint to get signed URL for syllabus PDF
//Fixting alternative apis for pdf syllabus entry and pdf show
app.get('/api/pdfsyllabuspurchasers', async (req, res) => {
  try {
    // Create a reference to the collection
    const ref = realtimeDatabase.ref('pdfsyllabuspurchasers');
    
    // Get all data from the reference
    const snapshot = await ref.once('value');
    
    // Convert the snapshot to JSON
    const data = snapshot.val();
    
    // If no data is found, return a 404
    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'No data found'
      });
    }
    
    // Return the data
    return res.status(200).json({
      success: true,
      data: data
    });
  } catch (error) {
    console.error('Error retrieving data:', error);
    return res.status(500).json({
      success: false,
      message: 'Error retrieving data from database',
      error: error.message
    });
  }
});
// API endpoint to get PDF syllabi with pre-signed URLs
app.get("/api/pdf-syllabi", async (req, res) => {
  try {
    const snapshot = await pdfSyllabusRef.once('value');
    const syllabi = {};
    
    // Process all syllabi and generate signed URLs
    const promises = [];
    
    snapshot.forEach((categorySnapshot) => {
      categorySnapshot.forEach((syllabusSnapshot) => {
        const syllabusData = syllabusSnapshot.val();
        const category = syllabusData.category;
        
        if (!syllabi[category]) {
          syllabi[category] = {};
        }
        
        // If we have a file path instead of a full URL
        if (syllabusData.filePath) {
          // Add to promises array for batch processing
          promises.push(
            generateSignedUrl(syllabusData.filePath)
              .then(signedUrl => {
                syllabusData.fileUrl = signedUrl;
                syllabi[category][syllabusData.title] = syllabusData;
              })
              .catch(error => {
                console.error(`Error generating signed URL for ${syllabusData.title}:`, error);
                // Still include the syllabus but mark it with an error flag
                syllabusData.fileError = true;
                syllabi[category][syllabusData.title] = syllabusData;
              })
          );
        } 
        // If we already have a full URL (legacy data)
        else if (syllabusData.fileUrl) {
          syllabi[category][syllabusData.title] = syllabusData;
        }
      });
    });
    
    // Wait for all signed URL generation to complete
    await Promise.all(promises);
    
    res.json(syllabi);
  } catch (error) {
    console.error("Error fetching PDF syllabi:", error);
    res.status(500).json({ error: "Failed to fetch PDF syllabi" });
  }
});
















//Admin APis===========================================================================================================================================================================================================================================================================================================================================


app.post("/api/exams/:examTitle/questions", upload.single("image"), async (req, res) => {
  const { examTitle } = req.params;
  const { question, options, correctAnswer } = req.body;
  const image = req.file;

  try {
      // Validate input
      if (!examTitle || !question || !options || correctAnswer === undefined) {
          return res.status(400).json({ error: "Missing required fields" });
      }

      // Parse options and correct answer
      const parsedOptions = JSON.parse(options);
      const parsedCorrectAnswer = parseInt(correctAnswer, 10);

      if (!Array.isArray(parsedOptions) || parsedOptions.length !== 4 || isNaN(parsedCorrectAnswer)) {
          return res.status(400).json({ error: "Invalid options or correct answer" });
      }

      // Firestore references
      const examCollection = firestore.collection("Exams").doc(examTitle);
      const questionsCollection = examCollection.collection("Questions");

      // Get the current count of questions to determine the new order
      const allQuestionsSnapshot = await questionsCollection.get();
      const nextOrder = allQuestionsSnapshot.size + 1;

      // Prepare question data with order field
      const questionData = {
          question,
          options: parsedOptions,
          correctAnswer: parsedCorrectAnswer,
          order: nextOrder,
          timestamp: new Date().getTime()
      };

      // Handle image (if present)
      if (image) {
          const base64Image = image.buffer.toString("base64");
          const mimeType = image.mimetype;
          questionData.image = `data:${mimeType};base64,${base64Image}`;
      }

      // Add question to Firestore
      const questionDoc = await questionsCollection.add(questionData);

      res.status(200).json({
          message: "Question added successfully",
          questionId: questionDoc.id,
          order: nextOrder
      });

  } catch (error) {
      console.error("Error saving question:", error);
      res.status(500).json({ error: "Internal server error" });
  }
});

app.put("/api/exams/:examTitle/questions/:questionId", upload.single("image"), async (req, res) => {
    const { examTitle, questionId } = req.params;
    const { question, options, correctAnswer } = req.body;
    const image = req.file;

    try {
        if (!examTitle || !questionId || !question || !options || correctAnswer === undefined) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const parsedOptions = JSON.parse(options);
        const parsedCorrectAnswer = parseInt(correctAnswer, 10);

        if (!Array.isArray(parsedOptions) || parsedOptions.length !== 4 || isNaN(parsedCorrectAnswer)) {
            return res.status(400).json({ error: "Invalid options or correct answer" });
        }

        const examCollection = firestore.collection("Exams").doc(examTitle);
        const questionDoc = examCollection.collection("Questions").doc(questionId);

        const updateData = {
            question,
            options: parsedOptions,
            correctAnswer: parsedCorrectAnswer,
        };

        if (image) {
            const base64Image = image.buffer.toString("base64");
            const mimeType = image.mimetype;
            updateData.image = `data:${mimeType};base64,${base64Image}`;
        }

        await questionDoc.update(updateData);

        res.status(200).json({ message: "Question updated successfully" });
    } catch (error) {
        console.error("Error updating question:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.delete("/api/exams/:examTitle/questions/:questionId", async (req, res) => {
  const { examTitle, questionId } = req.params;

  try {
      // Firestore references
      const examCollection = firestore.collection("Exams").doc(examTitle);
      const questionDoc = examCollection.collection("Questions").doc(questionId);

      // Delete the question document
      await questionDoc.delete();

      res.status(200).json({ message: "Question deleted successfully" });
  } catch (error) {
      console.error("Error deleting question:", error);
      res.status(500).json({ error: "Internal server error" });
  }
});


// API to get questions for a specific exam title
// API to save exam date and time
app.post("/api/exams/:examTitle/date-time", async (req, res) => {
  const { examTitle } = req.params;
  const { date, startTime, endTime, marks, price } = req.body;

  try {
    // Validate input
    if (!examTitle || !date || !startTime || !endTime || marks === undefined || price === undefined) {
      return res.status(400).json({
        error: "Missing required fields. Please provide date, startTime, endTime, marks, and price."
      });
    }

    // Validate 12-hour time format with AM/PM
    const timeRegex = /^(0?[1-9]|1[0-2]):[0-5][0-9]\s?(AM|PM)$/i;
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return res.status(400).json({
        error: "Invalid time format. Please provide time in 12-hour format (e.g., 1:45 PM)."
      });
    }

    // Reference to the exam date-time in Realtime Database
    const examDateTimeRef = realtimeDatabase.ref('ExamDateTime').child(examTitle);

    // Save the data to Realtime Database
    await examDateTimeRef.set({
      date,
      startTime,
      endTime,
      marks,
      price,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });

    // Update the exam document in Firestore
    const examRef = firestore.collection("Exams").doc(examTitle);
    await examRef.set({
      dateTime: {
        date,
        startTime,
        endTime,
        marks,
        price,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    }, { merge: true });

    res.status(200).json({
      message: "Exam details saved successfully",
      data: {
        examTitle,
        date,
        startTime,
        endTime,
        marks,
        price
      }
    });
  } catch (error) {
    console.error("Error saving exam details:", error);
    res.status(500).json({
      error: "Failed to save exam details",
      details: error.message
    });
  }
});
  
  // API to get exam date and time
  app.get("/api/exams/:examTitle/date-time", async (req, res) => {
    const { examTitle } = req.params;
  
    try {
      // Reference to the exam date-time in Realtime Database
      const examDateTimeRef = realtimeDatabase.ref('ExamDateTime').child(examTitle);
      
      // Get the data
      const snapshot = await examDateTimeRef.once('value');
      const dateTimeData = snapshot.val();
  
      if (!dateTimeData) {
        return res.status(404).json({ 
          error: "Exam date and time not found" 
        });
      }
  
      res.status(200).json({
        examTitle,
        ...dateTimeData
      });
  
    } catch (error) {
      console.error("Error fetching exam date and time:", error);
      res.status(500).json({ 
        error: "Failed to fetch exam date and time",
        details: error.message 
      });
    }
  });


  //Notification apis

  // API to save notification
app.post("/api/admin/notifications", async (req, res) => {
    const { message, createdAt } = req.body;
  
    try {
      // Validate input
      if (!message) {
        return res.status(400).json({ 
          error: "Missing required fields. Please provide a message" 
        });
      }
  
      // Generate a unique ID for the notification
      const notificationId = Date.now().toString();
  
      // Reference to the notifications in Realtime Database
      const notificationsRef = realtimeDatabase.ref('Notifications');
  
      // Save the notification
      await notificationsRef.child(notificationId).set({
        message,
        createdAt,
        updatedAt: admin.database.ServerValue.TIMESTAMP
      });
  
      res.status(200).json({
        message: "Notification saved successfully",
        data: {
          id: notificationId,
          message,
          createdAt
        }
      });
  
    } catch (error) {
      console.error("Error saving notification:", error);
      res.status(500).json({ 
        error: "Failed to save notification",
        details: error.message 
      });
    }
  });
  

  // API to update a notification
  app.put("/api/admin/notifications/:id", async (req, res) => {
    const { id } = req.params;
    const { message } = req.body;
  
    try {
      if (!message) {
        return res.status(400).json({ error: "Message is required" });
      }
  
      const notificationRef = realtimeDatabase.ref(`Notifications/${id}`);
      
      await notificationRef.update({
        message,
        updatedAt: admin.database.ServerValue.TIMESTAMP
      });
  
      res.status(200).json({
        message: "Notification updated successfully"
      });
  
    } catch (error) {
      console.error("Error updating notification:", error);
      res.status(500).json({ 
        error: "Failed to update notification",
        details: error.message 
      });
    }
  });
  
  // API to delete a notification
  app.delete("/api/notifications/:id", async (req, res) => {
    const { id } = req.params;
  
    try {
      const notificationRef = realtimeDatabase.ref(`Notifications/${id}`);
      await notificationRef.remove();
  
      res.status(200).json({
        message: "Notification deleted successfully"
      });
  
    } catch (error) {
      console.error("Error deleting notification:", error);
      res.status(500).json({ 
        error: "Failed to delete notification",
        details: error.message 
      });
    }
  });


  //Syllabus pdf
 // Save syllabus endpoint
app.post("/api/syllabus", async (req, res) => {
  try {
    const { examTitle, syllabusLink } = req.body;

    // Validate input
    if (!examTitle || !syllabusLink) {
      return res.status(400).json({
        error: "Missing required fields. Please provide exam title and syllabus link"
      });
    }

    // Generate unique ID
    const syllabusId = `syllabus_${Date.now()}`;

    // Create syllabus data object
    const syllabusData = {
      id: syllabusId,
      examTitle,
      syllabusLink,
      uploadedAt: new Date().toISOString(),
      updatedAt: admin.database.ServerValue.TIMESTAMP,
      version: "3.11.174"
    };

    // Save to Firebase Realtime Database
    const syllabusRef = admin.database().ref('Syllabus').child(syllabusId);
    await syllabusRef.set(syllabusData);

    res.status(200).json({
      message: "Syllabus saved successfully",
      data: syllabusData
    });

  } catch (error) {
    console.error("Error saving syllabus:", error);
    res.status(500).json({
      error: "Failed to save syllabus",
      details: error.message
    });
  }
});

// Get all syllabus endpoint
app.get("/api/syllabus", async (req, res) => {
  try {
    const syllabusRef = admin.database().ref("Syllabus");
    const snapshot = await syllabusRef.once("value");

    if (!snapshot.exists()) {
      return res.status(200).json({
        message: "No syllabus found",
        data: {},
        version: "3.11.174"
      });
    }

    const syllabusData = snapshot.val();

    res.status(200).json({
      message: "Syllabus fetched successfully",
      data: syllabusData,
      version: "3.11.174"
    });

  } catch (error) {
    console.error("Error fetching syllabus:", error);
    res.status(500).json({
      error: "Failed to fetch syllabus",
      details: error.message
    });
  }
});

// Update syllabus endpoint
app.put("/api/syllabus/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { examTitle, syllabusLink } = req.body;

    // Validate input
    if (!examTitle || !syllabusLink) {
      return res.status(400).json({
        error: "Missing required fields. Please provide exam title and syllabus link"
      });
    }

    const syllabusRef = admin.database().ref('Syllabus').child(id);
    const snapshot = await syllabusRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Syllabus not found" });
    }

    const updatedData = {
      ...snapshot.val(),
      examTitle,
      syllabusLink,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    };

    await syllabusRef.update(updatedData);

    res.status(200).json({
      message: "Syllabus updated successfully",
      data: updatedData
    });

  } catch (error) {
    console.error("Error updating syllabus:", error);
    res.status(500).json({
      error: "Failed to update syllabus",
      details: error.message
    });
  }
});

// Delete syllabus endpoint
app.delete("/api/syllabus/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const syllabusRef = admin.database().ref('Syllabus').child(id);
    
    const snapshot = await syllabusRef.once('value');
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Syllabus not found" });
    }

    await syllabusRef.remove();

    res.status(200).json({
      message: "Syllabus deleted successfully"
    });

  } catch (error) {
    console.error("Error deleting syllabus:", error);
    res.status(500).json({
      error: "Failed to delete syllabus",
      details: error.message
    });
  }
});


//Api for q/a upload
app.post("/api/exam-qa", async (req, res) => {
  try {
    const { examTitle, qaLink } = req.body;

    // Validate input
    if (!examTitle || !qaLink) {
      return res.status(400).json({
        error: "Missing required fields. Please provide exam title and Q&A link.",
      });
    }

    // Generate unique ID for the Q&A entry
    const qaId = `qa_${Date.now()}`;

    // Create Q&A data object
    const qaData = {
      id: qaId,
      examTitle,
      qaLink,
      uploadedAt: new Date().toISOString(),
      version: "1.0.0", // Optional: Add version or metadata
    };

    // Save to Firebase Realtime Database
    const qaRef = admin.database().ref("ExamQA").child(qaId);
    await qaRef.set(qaData);

    // Respond with success
    res.status(200).json({
      message: "Exam Q&A saved successfully",
      data: qaData,
    });
  } catch (error) {
    console.error("Error saving Q&A details:", error);
    res.status(500).json({
      error: "Failed to save Q&A details",
      details: error.message,
    });
  }
});

  
// API to get all concerns from Firestore
app.get("/api/concerns", async (req, res) => {
  try {
      // Reference to the concerns collection in Firestore
      const concernsRef = firestore.collection("concerns");

      // Get all concerns
      const snapshot = await concernsRef.get();

      if (snapshot.empty) {
          return res.status(404).json({
              message: "No concerns found",
          });
      }

      // Convert Firestore documents to an array of concern objects
      const concerns = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data(),
      }));

      // Return concerns to the client
      res.status(200).json({
          concerns,
      });
  } catch (error) {
      console.error("Error fetching concerns:", error);
      res.status(500).json({
          error: "Failed to fetch concerns",
          details: error.message,
      });
  }
});

// API to delete a concern
app.delete("/api/concerns/:id", async (req, res) => {
  try {
    const concernId = req.params.id;

    // Reference to the specific concern in Firestore
    const concernRef = firestore.collection("concerns").doc(concernId);

    // Delete the concern document
    await concernRef.delete();

    res.status(200).json({ message: "Concern deleted successfully" });
  } catch (error) {
    console.error("Error deleting concern:", error);
    res.status(500).json({ error: "Failed to delete concern", details: error.message });
  }
});



//Login page
// Admin Login Validation API
app.get("/api/admin/login", async (req, res) => {
  const { userid, password } = req.query;

  if (!userid || !password) {
    return res.status(400).json({ error: "User ID and Password are required." });
  }

  try {
    const db = admin.database();
    const ref = db.ref("Adminlogin");

    // Fetch stored admin credentials
    const snapshot = await ref.once("value");
    const adminData = snapshot.val();

    // Log the incoming and stored data
    console.log("Incoming request: ", { userid, password });
    console.log("Stored admin data: ", adminData);

    // Compare provided credentials with stored ones
    if (adminData.userid === userid.trim() && adminData.password === password.trim()) {
      return res.status(200).json({ message: "Login successful!" });
    } else {
      return res.status(401).json({ error: "Invalid User ID or Password." });
    }
  } catch (error) {
    console.error("Error fetching admin data:", error);
    return res.status(500).json({ error: "Internal Server Error." });
  }
});


//Api for candidates section
app.get('/api/admin/candidates', async (req, res) => {
  try {
    // Fetch all candidate documents from the 'candidates' collection
    const snapshot = await firestore.collection('candidates').get();

    if (snapshot.empty) {
      return res.status(404).json({ message: 'No candidates found' });
    }

    // Map through the documents and return the candidate data
    const candidates = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ message: 'Candidates fetched successfully', candidates });
  } catch (error) {
    console.error('Error fetching candidates:', error);
    res.status(500).json({ error: 'Failed to fetch candidates' });
  }
});

app.get("/api/admin/exams", async (req, res) => {
  try {
    const examsRef = firestore.collection("Exams");
    const examSnapshot = await examsRef.get();
    
    const exams = [];
    
    // Fetch each exam and its subcollections
    for (const examDoc of examSnapshot.docs) {
      const examData = examDoc.data();
      const examId = examDoc.id;
      
      // Get exam details subcollection
      const examDetailsRef = examsRef.doc(examId);
      const examDetailsSnapshot = await examDetailsRef.get();
      
      // Get questions subcollection
      const questionsRef = examDetailsRef.collection("Questions");
      const questionsSnapshot = await questionsRef.get();
      
      const questions = [];
      questionsSnapshot.forEach(questionDoc => {
        questions.push({
          id: questionDoc.id,
          ...questionDoc.data()
        });
      });

      // Combine all data
      exams.push({
        id: examId,
        ...examData,
        examDetails: examDetailsSnapshot.data(),
        questions: questions
      });
    }
    
    res.status(200).json({
      success: true,
      data: exams
    });
    
  } catch (error) {
    console.error("Error fetching exams:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch exams",
      details: error.message
    });
  }
});


// Add this new API endpoint to your existing Express app
// Modified API endpoint
app.get("/api/today-exam-results", async (req, res) => {
  try {
    const today = moment().format('YYYY-MM-DD');

    // Step 1: Get today's exam from Firestore
    const examsSnapshot = await firestore.collection('Exams').get();
    let todayExam = null;
    let examQuestions = [];

    // Find today's exam
    for (const doc of examsSnapshot.docs) {
      const examData = doc.data();
      if (examData.dateTime?.date === today) {
        todayExam = {
          id: doc.id,
          ...examData.dateTime
        };

        // Get questions for this exam
        const questionsSnapshot = await doc.ref.collection('Questions').orderBy('order').get();
        examQuestions = questionsSnapshot.docs.map(qDoc => ({
          id: qDoc.id,
          ...qDoc.data()
        }));
        break;
      }
    }

    if (!todayExam) {
      return res.status(404).json({
        success: false,
        message: 'No exam found for today'
      });
    }

    // Step 2: Get candidates who took this exam
    const candidatesSnapshot = await firestore.collection('candidates')
      .where('exam', '==', todayExam.id)
      .get();

    const results = [];

    // Step 3: Process each candidate's answers
    for (const candidateDoc of candidatesSnapshot.docs) {
      const candidateData = candidateDoc.data();

      // Get candidate's answers
      const answersSnapshot = await candidateDoc.ref.collection('answers').get();
      const answers = answersSnapshot.docs.map(aDoc => ({
        id: aDoc.id,
        ...aDoc.data()
      }));

      // Calculate results
      let correctAnswers = 0;
      let skippedQuestions = 0;

      examQuestions.forEach(question => {
        const candidateAnswer = answers.find(a => a.order === question.order);

        if (!candidateAnswer || candidateAnswer.skipped) {
          skippedQuestions++;
        } else if (candidateAnswer.answer === question.correctAnswer) {
          correctAnswers++;
        }
      });

      // Get submitted and used status from candidate data
      const submitted = candidateData.submitted || false;
      const used = candidateData.used || false;

      // Prepare result object with status flags
      const resultData = {
        registrationNumber: candidateDoc.id,
        candidateName: candidateData.candidateName,
        phone: candidateData.phone,
        totalQuestions: examQuestions.length,
        correctAnswers,
        skippedQuestions,
        wrongAnswers: examQuestions.length - (correctAnswers + skippedQuestions),
        submitted,
        used
      };

      results.push(resultData);

      // Store results in Realtime Database
      const resultRef = realtimeDatabase.ref(`Results/${todayExam.id}/${candidateDoc.id}`);
      await resultRef.set({
        ...resultData,
        timestamp: new Date().toISOString()
      });
    }

    res.status(200).json({
      success: true,
      examDetails: {
        examName: todayExam.id,
        date: todayExam.date,
        startTime: todayExam.startTime,
        endTime: todayExam.endTime,
        totalMarks: todayExam.marks
      },
      results
    });

  } catch (error) {
    console.error('Error fetching exam results:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch exam results',
      details: error.message
    });
  }
});

app.get("/api/all-exam-results", async (req, res) => {
  try {
    // Reference to the Results node in Realtime Database
    const resultsRef = realtimeDatabase.ref('Results');
    
    // Fetch all results
    const snapshot = await resultsRef.once('value');
    const resultsData = snapshot.val();

    // If no results exist
    if (!resultsData) {
      return res.status(200).json({
        success: true,
        message: "No exam results found",
        data: {}
      });
    }

    // Transform the data into a more structured format
    const formattedResults = Object.entries(resultsData).map(([examId, examData]) => ({
      examId,
      candidates: Object.entries(examData).map(([registrationId, candidateData]) => ({
        registrationId,
        ...candidateData
      }))
    }));

    res.status(200).json({
      success: true,
      message: "Exam results fetched successfully",
      data: formattedResults,
      metadata: {
        totalExams: formattedResults.length,
        totalCandidates: formattedResults.reduce((total, exam) => 
          total + exam.candidates.length, 0
        )
      }
    });

  } catch (error) {
    console.error("Error fetching exam results:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch exam results",
      details: error.message
    });
  }
});


// delte apis
app.delete("/api/candidates", async (req, res) => {
  try {
      // Firestore reference to the "Candidates" collection
      const candidatesCollection = firestore.collection("Candidates");

      // Fetch all documents in the "Candidates" collection
      const candidatesSnapshot = await candidatesCollection.get();

      // Iterate through each document in the "Candidates" collection
      for (const candidateDoc of candidatesSnapshot.docs) {
          const candidateDocRef = candidateDoc.ref;

          // Delete the "answers" document in the candidate's sub-collection, if it exists
          const answersDocRef = candidateDocRef.collection("SubCollection").doc("answers");
          const answersDoc = await answersDocRef.get();
          if (answersDoc.exists) {
              await answersDocRef.delete();
          }

          // Delete any sub-collections under the candidate document
          const subCollections = await candidateDocRef.listCollections();
          for (const subCollection of subCollections) {
              const subCollectionRef = firestore.collection(subCollection.path);
              const subCollectionDocs = await subCollectionRef.get();
              for (const doc of subCollectionDocs.docs) {
                  await doc.ref.delete();
              }
          }

          // Delete the candidate document itself
          await candidateDocRef.delete();
      }

      res.status(200).json({ message: "Candidates collection and related data deleted successfully" });
  } catch (error) {
      console.error("Error deleting Candidates data:", error);
      res.status(500).json({ error: "Internal server error" });
  }
});


//Apis see details of winners
app.get('/api/winners', async (req, res) => {
  try {
    // Reference to Winners collection
    const winnersRef = realtimeDatabase.ref('Winners');
    
    // Get all data from Winners node
    const snapshot = await winnersRef.once('value');
    const winnersData = snapshot.val();
    
    // If no data exists
    if (!winnersData) {
      return res.status(404).json({
        success: false,
        error: 'No winners data found'
      });
    }
    
    // Transform data into a more organized structure
    const formattedData = {};
    
    // Iterate through exam titles
    Object.entries(winnersData).forEach(([examTitle, examData]) => {
      formattedData[examTitle] = [];
      
      // Iterate through registrations under each exam
      Object.entries(examData).forEach(([regNumber, winnerDetails]) => {
        formattedData[examTitle].push({
          registrationNumber: regNumber,
          ...winnerDetails
        });
      });
      
      // Sort winners by rank for each exam
      formattedData[examTitle].sort((a, b) => a.rank - b.rank);
    });
    
    // Prepare response
    const response = {
      success: true,
      data: {
        message: 'Winners data retrieved successfully',
        winners: formattedData
      }
    };
    
    res.status(200).json(response);
    
  } catch (error) {
    console.error('Error retrieving winners data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve winners data',
      details: error.message
    });
  }
});

app.put('/api/winners/status', async (req, res) => {
  try {
    const { examTitle, registrationNumber, status } = req.body;

    // Validate required fields
    if (!examTitle || !registrationNumber || !status) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Reference to specific winner's status
    const winnerRef = realtimeDatabase.ref(`Winners/${examTitle}/${registrationNumber}`);

    // Update the status
    await winnerRef.update({ status });

    // Return success response
    res.status(200).json({
      success: true,
      data: {
        message: 'Winner status updated successfully'
      }
    });

  } catch (error) {
    console.error('Error updating winner status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update winner status',
      details: error.message
    });
  }
});





//Practice Test Apis down


//Practice Categry

// Reference to categories in realtime database
const categoriesRef = realtimeDatabase.ref('Practicecategories');

// category apis
// Create category
app.post("/api/categories", async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Category name is required" });
    }

    const newCategoryRef = categoriesRef.push();
    await newCategoryRef.set({
      name,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    res.status(201).json({
      id: newCategoryRef.key,
      name
    });
  } catch (error) {
    console.error("Error creating category:", error);
    res.status(500).json({ error: "Failed to create category" });
  }
});

// Get all categories
app.get("/api/categories", async (req, res) => {
  try {
    const snapshot = await categoriesRef.once('value');
    const categories = [];
    
    snapshot.forEach((childSnapshot) => {
      categories.push({
        id: childSnapshot.key,
        ...childSnapshot.val()
      });
    });

    res.json(categories);
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});


// Update category
app.put("/api/categories/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Category name is required" });
    }

    const categoryRef = categoriesRef.child(id);
    await categoryRef.update({
      name,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });

    res.json({ id, name });
  } catch (error) {
    console.error("Error updating category:", error);
    res.status(500).json({ error: "Failed to update category" });
  }
});

// Delete category
app.delete("/api/categories/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await categoriesRef.child(id).remove();
    res.json({ message: "Category deleted successfully" });
  } catch (error) {
    console.error("Error deleting category:", error);
    res.status(500).json({ error: "Failed to delete category" });
  }
});



//Apis for preatice test detsils
app.post("/api/practice-tests", async (req, res) => {
  try {
    const { category, title, fees, duration, timeLimit } = req.body;

    if (!category || !title) {
      return res.status(400).json({ error: "Category and Title are required" });
    }

    const newTestRef = practiceTestsRef.child(category).child(title);

    await newTestRef.set({
      fees: fees || 0,
      duration: duration || "N/A",
      timeLimit: timeLimit || "N/A",
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    res.status(201).json({
      message: "Practice test added successfully",
      category,
      title,
      fees,
      duration,
      timeLimit
    });
  } catch (error) {
    console.error("Error adding practice test:", error);
    res.status(500).json({ error: "Failed to add practice test" });
  }
});


app.get("/api/practice-tests", async (req, res) => {
  try {
    const snapshot = await practiceTestsRef.once('value');
    const practiceTests = {};

    snapshot.forEach((categorySnapshot) => {
      const category = categorySnapshot.key;
      practiceTests[category] = {};

      categorySnapshot.forEach((titleSnapshot) => {
        practiceTests[category][titleSnapshot.key] = titleSnapshot.val();
      });
    });

    res.json(practiceTests);
  } catch (error) {
    console.error("Error fetching practice tests:", error);
    res.status(500).json({ error: "Failed to fetch practice tests" });
  }
});


app.get("/api/practice-tests/:category", async (req, res) => {
  try {
    const { category } = req.params;
    const categoryRef = practiceTestsRef.child(category);

    const snapshot = await categoryRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Category not found" });
    }

    res.json(snapshot.val());
  } catch (error) {
    console.error("Error fetching category practice tests:", error);
    res.status(500).json({ error: "Failed to fetch category practice tests" });
  }
});


app.delete("/api/practice-tests/:category/:title", async (req, res) => {
  try {
    const { category, title } = req.params;
    const testRef = practiceTestsRef.child(category).child(title);

    const snapshot = await testRef.once('value');
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Practice test not found" });
    }

    await testRef.remove();

    res.json({ message: "Practice test deleted successfully" });
  } catch (error) {
    console.error("Error deleting practice test:", error);
    res.status(500).json({ error: "Failed to delete practice test" });
  }
});



//Practice Questions api 

// API to add a question to a specific practice test
app.post("/api/practice-tests/:category/:examId/questions", upload.single("image"), async (req, res) => {
  const { category, examId } = req.params;
  const { question, options, correctAnswer, compressImage } = req.body;
  const image = req.file;

  try {
    // Validate input
    if (!category || !examId || !question || !options || correctAnswer === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Parse options and correct answer
    const parsedOptions = JSON.parse(options);
    const parsedCorrectAnswer = parseInt(correctAnswer, 10);

    if (!Array.isArray(parsedOptions) || parsedOptions.length !== 4 || isNaN(parsedCorrectAnswer)) {
      return res.status(400).json({ error: "Invalid options or correct answer" });
    }

    // Firestore references
    const examDocRef = firestore.collection("PracticeTests").doc(category).collection("Exams").doc(examId);
    const questionsCollection = examDocRef.collection("Questions");

    // Get the current count of questions to determine the new order
    const allQuestionsSnapshot = await questionsCollection.get();
    const nextOrder = allQuestionsSnapshot.size + 1;

    // Prepare question data with order field
    const questionData = {
      question,
      options: parsedOptions,
      correctAnswer: parsedCorrectAnswer,
      order: nextOrder,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    // Handle image upload to Firebase Storage if present
    if (image) {
      const fileExtension = image.originalname.split('.').pop();
      const fileName = `practice-tests/${category}/${examId}/questions/${uuidv4()}.${fileExtension}`;
      const file = bucket.file(fileName);

      let imageBuffer = image.buffer;
      
      // Apply compression if requested and it's a JPEG or PNG
      if (compressImage === "true" && ['jpg', 'jpeg', 'png'].includes(fileExtension.toLowerCase())) {
        try {
          // Optimize image - reduce size while maintaining quality
          imageBuffer = await sharp(image.buffer)
            .resize({ 
              width: 1200, // max width
              height: 1200, // max height
              fit: 'inside',
              withoutEnlargement: true 
            })
            .jpeg({ quality: 80 }) // For JPEGs, adjust quality
            .toBuffer();
        } catch (err) {
          console.warn("Image optimization failed, using original:", err);
          // Fall back to original image if optimization fails
          imageBuffer = image.buffer;
        }
      }

      // Create a write stream with better settings
      const stream = file.createWriteStream({
        metadata: {
          contentType: image.mimetype,
          cacheControl: 'public, max-age=31536000', // Cache for 1 year
        },
        resumable: false, // Disable resumable uploads for small files to speed up process
      });

      // Upload and save to Firestore concurrently
      let imageUrl = null;
      
      // Handle stream errors
      const uploadPromise = new Promise((resolve, reject) => {
        stream.on("error", (error) => {
          console.error("Upload error:", error);
          reject(error);
        });

        stream.on("finish", async () => {
          // Make the file publicly accessible
          await file.makePublic();

          // Get the public URL
          imageUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
          resolve();
        });

        // Write the file buffer to storage
        stream.end(imageBuffer);
      });

      try {
        await uploadPromise;
        
        // Add image URL to question data
        if (imageUrl) {
          questionData.imageUrl = imageUrl;
        }
        
        // Add question to Firestore
        const questionDoc = await questionsCollection.add(questionData);
        
        return res.status(200).json({
          message: "Question added successfully",
          questionId: questionDoc.id,
          order: nextOrder,
          imageUrl
        });
      } catch (error) {
        console.error("Error in upload or save:", error);
        return res.status(500).json({ error: "Failed to save question data" });
      }
    } else {
      // Add question to Firestore without image
      const questionDoc = await questionsCollection.add(questionData);

      return res.status(200).json({
        message: "Question added successfully",
        questionId: questionDoc.id,
        order: nextOrder
      });
    }
  } catch (error) {
    console.error("Error saving question:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// API to update a question
app.put("/api/practice-tests/:category/:examId/questions/:questionId", upload.single("image"), async (req, res) => {
  const { category, examId, questionId } = req.params;
  const { question, options, correctAnswer, compressImage } = req.body;
  const image = req.file;

  try {
    // Validate input
    if (!category || !examId || !questionId || !question || !options || correctAnswer === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Parse options and correct answer
    const parsedOptions = JSON.parse(options);
    const parsedCorrectAnswer = parseInt(correctAnswer, 10);

    if (!Array.isArray(parsedOptions) || parsedOptions.length !== 4 || isNaN(parsedCorrectAnswer)) {
      return res.status(400).json({ error: "Invalid options or correct answer" });
    }

    // Firestore references
    const questionDocRef = firestore.collection("PracticeTests").doc(category)
      .collection("Exams").doc(examId)
      .collection("Questions").doc(questionId);

    // Get the current question data
    const questionSnapshot = await questionDocRef.get();
    if (!questionSnapshot.exists) {
      return res.status(404).json({ error: "Question not found" });
    }

    const currentData = questionSnapshot.data();

    // Prepare update data
    const updateData = {
      question,
      options: parsedOptions,
      correctAnswer: parsedCorrectAnswer,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Handle image upload if a new image is provided
    if (image) {
      // Prepare for deleting the old image if it exists
      let deletePromise = Promise.resolve();
      if (currentData.imageUrl) {
        try {
          const oldImagePath = decodeURIComponent(currentData.imageUrl.split('/').slice(4).join('/'));
          deletePromise = bucket.file(oldImagePath).delete().catch(err => {
            console.warn("Error deleting old image, continuing:", err);
            // Continue even if deletion fails
          });
        } catch (error) {
          console.warn("Error parsing old image path:", error);
          // Continue even if path parsing fails
        }
      }

      // Process new image while old one is being deleted
      const fileExtension = image.originalname.split('.').pop();
      const fileName = `practice-tests/${category}/${examId}/questions/${uuidv4()}.${fileExtension}`;
      const file = bucket.file(fileName);

      let imageBuffer = image.buffer;
      
      // Apply compression if requested and it's a JPEG or PNG
      if (compressImage === "true" && ['jpg', 'jpeg', 'png'].includes(fileExtension.toLowerCase())) {
        try {
          imageBuffer = await sharp(image.buffer)
            .resize({ 
              width: 1200,
              height: 1200,
              fit: 'inside',
              withoutEnlargement: true 
            })
            .jpeg({ quality: 80 })
            .toBuffer();
        } catch (err) {
          console.warn("Image optimization failed, using original:", err);
          imageBuffer = image.buffer;
        }
      }

      // Create a write stream with better settings
      const stream = file.createWriteStream({
        metadata: {
          contentType: image.mimetype,
          cacheControl: 'public, max-age=31536000',
        },
        resumable: false,
      });

      // Upload image and handle both promises
      let imageUrl = null;
      
      const uploadPromise = new Promise((resolve, reject) => {
        stream.on("error", (error) => {
          console.error("Upload error:", error);
          reject(error);
        });

        stream.on("finish", async () => {
          // Make the file publicly accessible
          await file.makePublic();

          // Get the public URL
          imageUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
          resolve();
        });

        // Write the file buffer to storage
        stream.end(imageBuffer);
      });

      try {
        // Wait for both deletion and upload to complete
        await Promise.all([deletePromise, uploadPromise]);
        
        // Add image URL to update data
        if (imageUrl) {
          updateData.imageUrl = imageUrl;
        }
        
        // Update question in Firestore
        await questionDocRef.update(updateData);
        
        return res.status(200).json({
          message: "Question updated successfully",
          imageUrl
        });
      } catch (error) {
        console.error("Error in upload or update:", error);
        return res.status(500).json({ error: "Failed to update question data" });
      }
    } else {
      // Update question without changing the image
      await questionDocRef.update(updateData);

      return res.status(200).json({
        message: "Question updated successfully"
      });
    }
  } catch (error) {
    console.error("Error updating question:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// API to delete a question
app.delete("/api/practice-tests/:category/:examId/questions/:questionId", async (req, res) => {
  const { category, examId, questionId } = req.params;

  try {
    // Firestore references
    const questionDocRef = firestore.collection("PracticeTests").doc(category)
      .collection("Exams").doc(examId)
      .collection("Questions").doc(questionId);

    // Get the question data to check for image
    const questionSnapshot = await questionDocRef.get();
    if (!questionSnapshot.exists) {
      return res.status(404).json({ error: "Question not found" });
    }

    const questionData = questionSnapshot.data();

    // Delete image from Storage if it exists
    if (questionData.imageUrl) {
      try {
        const imagePath = decodeURIComponent(questionData.imageUrl.split('/').slice(4).join('/'));
        await bucket.file(imagePath).delete();
      } catch (deleteError) {
        console.warn("Error deleting image:", deleteError);
        // Continue with deletion even if image deletion fails
      }
    }

    // Delete the question document
    await questionDocRef.delete();

    // Return success response
    res.status(200).json({ message: "Question deleted successfully" });
  } catch (error) {
    console.error("Error deleting question:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// API to get all questions for a specific exam
app.get("/api/practice-tests/:category/:examId/questions", async (req, res) => {
  const { category, examId } = req.params;

  try {
    // Firestore references
    const questionsCollection = firestore.collection("PracticeTests").doc(category)
      .collection("Exams").doc(examId)
      .collection("Questions");

    // Get all questions ordered by the 'order' field
    const questionsSnapshot = await questionsCollection.orderBy("order", "asc").get();

    if (questionsSnapshot.empty) {
      return res.status(200).json({ questions: [] });
    }

    // Transform the snapshot to an array of questions
    const questions = [];
    questionsSnapshot.forEach((doc) => {
      const questionData = doc.data();
      questions.push({
        id: doc.id,
        question: questionData.question,
        options: questionData.options,
        correctAnswer: questionData.correctAnswer,
        imageUrl: questionData.imageUrl || null,
        order: questionData.order
      });
    });

    // Return the questions
    res.status(200).json({ questions });
  } catch (error) {
    console.error("Error fetching questions:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// API to save exam date and time for practice tests
app.post("/api/practice-tests/:category/:examId/date-time", async (req, res) => {
  const { category, examId } = req.params;
  const { date, startTime, endTime, marks, price } = req.body;

  try {
    // Validate input
    if (!category || !examId || !date || !startTime || !endTime || marks === undefined || price === undefined) {
      return res.status(400).json({
        error: "Missing required fields. Please provide date, startTime, endTime, marks, and price."
      });
    }

    // Validate 12-hour time format with AM/PM
    const timeRegex = /^(0?[1-9]|1[0-2]):[0-5][0-9]\s?(AM|PM)$/i;
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return res.status(400).json({
        error: "Invalid time format. Please provide time in 12-hour format (e.g., 1:45 PM)."
      });
    }

    // Store data in both Realtime Database and Firestore
    const dateTimeData = {
      date,
      startTime,
      endTime,
      marks,
      price,
      updatedAt: firebaseAdmin.database.ServerValue.TIMESTAMP
    };

    // Reference to the exam date-time in Realtime Database
    const examDateTimeRef = firebaseAdmin.database()
      .ref(`PracticeTestDateTime/${category}/${examId}`);

    // Reference to the exam in Firestore
    const examRef = firestore.collection("PracticeTests").doc(category)
      .collection("Exams").doc(examId);

    // Save to Realtime Database
    await examDateTimeRef.set(dateTimeData);

    // Update Firestore document
    await examRef.set({
      dateTime: {
        date,
        startTime,
        endTime,
        marks,
        price,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    }, { merge: true });

    res.status(200).json({
      message: "Practice test details saved successfully",
      data: {
        category,
        examId,
        date,
        startTime,
        endTime,
        marks,
        price
      }
    });
  } catch (error) {
    console.error("Error saving practice test details:", error);
    res.status(500).json({
      error: "Failed to save practice test details",
      details: error.message
    });
  }
});

// API to get exam date and time for practice tests
app.get("/api/practice-tests/:category/:examId/date-time", async (req, res) => {
  const { category, examId } = req.params;

  try {
    // Reference to the exam date-time in Realtime Database
    const examDateTimeRef = firebaseAdmin.database()
      .ref(`PracticeTestDateTime/${category}/${examId}`);
    
    // Get the data
    const snapshot = await examDateTimeRef.once('value');
    const dateTimeData = snapshot.val();

    if (!dateTimeData) {
      return res.status(404).json({ 
        error: "Practice test date and time not found" 
      });
    }

    res.status(200).json({
      category,
      examId,
      ...dateTimeData
    });
  } catch (error) {
    console.error("Error fetching practice test date and time:", error);
    res.status(500).json({ 
      error: "Failed to fetch practice test date and time",
      details: error.message 
    });
  }
});


//Api Students who purchased exams
// GET API to fetch all students data
app.get('/api/practicetestpurchasedstudents', async (req, res) => {
  try {  
    // Create a reference to the collection
    const ref = realtimeDatabase.ref('practicetestpurchasedstudents');
    
    // Get all data from the reference
    const snapshot = await ref.once('value');
    
    // Convert the snapshot to JSON
    const data = snapshot.val();
    
    // If no data is found, return a 404
    if (!data) {
      return res.status(404).json({ 
        success: false, 
        message: 'No data found' 
      });
    }
    
    // Return the data
    return res.status(200).json({
      success: true,
      data: data
    });
  } catch (error) {
    console.error('Error retrieving data:', error);
    return res.status(500).json({
      success: false,
      message: 'Error retrieving data from database',
      error: error.message
    });
  }
});




//Pdf syallbus realted apis

//Pdf syllabus category apis
// Create PDF syllabus category

// Reference to categories in realtime database
const pdfsyllabuscategoryRef = realtimeDatabase.ref('pdfsyllabuscategoryRef');
app.post("/api/pdfsyllabuscategories", async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: "Category name is required" });
    }
    
    const newPdfSyllabusCategoryRef = pdfsyllabuscategoryRef.push();
    await newPdfSyllabusCategoryRef.set({
      name,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });
    
    res.status(201).json({
      id: newPdfSyllabusCategoryRef.key,
      name
    });
  } catch (error) {
    console.error("Error creating PDF syllabus category:", error);
    res.status(500).json({ error: "Failed to create PDF syllabus category" });
  }
});

// Get all PDF syllabus categories
app.get("/api/pdfsyllabuscategories", async (req, res) => {
  try {
    const snapshot = await pdfsyllabuscategoryRef.once('value');
    const pdfsyllabuscategories = [];
    
    snapshot.forEach((childSnapshot) => {
      pdfsyllabuscategories.push({
        id: childSnapshot.key,
        ...childSnapshot.val()
      });
    });
    
    res.json(pdfsyllabuscategories);
  } catch (error) {
    console.error("Error fetching PDF syllabus categories:", error);
    res.status(500).json({ error: "Failed to fetch PDF syllabus categories" });
  }
});

// Update PDF syllabus category
app.put("/api/pdfsyllabuscategories/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: "Category name is required" });
    }
    
    const pdfsyllabusCategoryRef = pdfsyllabuscategoryRef.child(id);
    await pdfsyllabusCategoryRef.update({
      name,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });
    
    res.json({ id, name });
  } catch (error) {
    console.error("Error updating PDF syllabus category:", error);
    res.status(500).json({ error: "Failed to update PDF syllabus category" });
  }
});

// Delete PDF syllabus category
app.delete("/api/pdfsyllabuscategories/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    await pdfsyllabuscategoryRef.child(id).remove();
    res.json({ message: "PDF syllabus category deleted successfully" });
  } catch (error) {
    console.error("Error deleting PDF syllabus category:", error);
    res.status(500).json({ error: "Failed to delete PDF syllabus category" });
  }
});



//Pdf Sylabus details

// PDF Syllabus API Endpoints

// Firestore setup references
// Utility function to sanitize filename for storage
const sanitizeFilename = (filename) => {
  return filename
    .replace(/[^a-zA-Z0-9.-]/g, '_') // Replace non-alphanumeric chars with underscore
    .replace(/_{2,}/g, '_');         // Replace multiple underscore with single one
};

// Create or update PDF syllabus
// Use pdfUpload.single for the PDF file upload route
app.post("/api/pdf-syllabi", pdfUpload.single('pdfFile'), async (req, res) => {
  try {
    // After Multer processes the file, it will be available as req.file
    if (!req.file) {
      return res.status(400).json({ error: "PDF file is required" });
    }
    
    const { category, title, fees, duration } = req.body;
    
    if (!category || !title) {
      return res.status(400).json({ error: "Category and title are required" });
    }
    
    // The file data is now in req.file
    const pdfFile = req.file;
    const timestamp = Date.now();
    const sanitizedTitle = sanitizeFilename(title);
    const sanitizedCategory = sanitizeFilename(category);
    
    // Create a unique file path in Firebase Storage
    const filePath = `pdfsyllabi/${sanitizedCategory}/${sanitizedTitle}_${timestamp}.pdf`;
    
    // Upload file to Firebase Storage
    const fileBuffer = pdfFile.buffer; // With Multer, file data is in the buffer property
    const file = bucket.file(filePath);
    
    await file.save(fileBuffer, {
      metadata: {
        contentType: 'application/pdf',
        metadata: {
          originalName: pdfFile.originalname, // With Multer, the file name is in originalname property
          category,
          title
        }
      }
    });
    
    // Get the public URL of the file
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: '03-01-2500' // Long expiration date
    });
    
    // Create syllabus entry in Realtime Database
    const syllabusData = {
      title,
      category,
      fees: parseFloat(fees) || 0,
      duration: duration ? `${duration} days` : "N/A",
      filePath,
      fileUrl: url,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    
    const syllabusKey = `${sanitizedCategory}/${sanitizedTitle}`;
    await pdfSyllabusRef.child(syllabusKey).set(syllabusData);
    
    res.status(201).json({
      message: "PDF syllabus created successfully",
      data: {
        id: syllabusKey,
        ...syllabusData
      }
    });
  } catch (error) {
    console.error("Error creating PDF syllabus:", error);
    res.status(500).json({ error: "Failed to create PDF syllabus" });
  }
});

// Update PDF syllabus
app.put("/api/pdf-syllabi/:category/:title", async (req, res) => {
  try {
    const { category, title } = req.params;
    const { newCategory, newTitle, fees, duration } = req.body;
    
    if (!newCategory || !newTitle) {
      return res.status(400).json({ error: "Category and title are required" });
    }
    
    const sanitizedOldCategory = sanitizeFilename(category);
    const sanitizedOldTitle = sanitizeFilename(title);
    const oldSyllabusKey = `${sanitizedOldCategory}/${sanitizedOldTitle}`;
    
    // Check if syllabus exists
    const syllabusSnapshot = await pdfSyllabusRef.child(oldSyllabusKey).once('value');
    const syllabusData = syllabusSnapshot.val();
    
    if (!syllabusData) {
      return res.status(404).json({ error: "PDF syllabus not found" });
    }
    
    // Update metadata
    const updatedData = {
      ...syllabusData,
      title: newTitle,
      category: newCategory,
      fees: parseFloat(fees) || 0,
      duration: duration ? `${duration} days` : "N/A",
      updatedAt: Date.now()
    };
    
    // If category or title changed, we need to create a new entry and delete the old one
    if (category !== newCategory || title !== newTitle) {
      const sanitizedNewCategory = sanitizeFilename(newCategory);
      const sanitizedNewTitle = sanitizeFilename(newTitle);
      const newSyllabusKey = `${sanitizedNewCategory}/${sanitizedNewTitle}`;
      
      // Create new entry with updated data
      await pdfSyllabusRef.child(newSyllabusKey).set(updatedData);
      
      // Delete old entry
      await pdfSyllabusRef.child(oldSyllabusKey).remove();
      
      res.json({
        message: "PDF syllabus updated successfully",
        data: {
          id: newSyllabusKey,
          ...updatedData
        }
      });
    } else {
      // Update existing entry
      await pdfSyllabusRef.child(oldSyllabusKey).update(updatedData);
      
      res.json({
        message: "PDF syllabus updated successfully",
        data: {
          id: oldSyllabusKey,
          ...updatedData
        }
      });
    }
    
  } catch (error) {
    console.error("Error updating PDF syllabus:", error);
    res.status(500).json({ error: "Failed to update PDF syllabus" });
  }
});

// Replace PDF file for existing syllabus
app.put("/api/pdf-syllabi/:category/:title/file", async (req, res) => {
  try {
    if (!req.files || !req.files.pdfFile) {
      return res.status(400).json({ error: "PDF file is required" });
    }
    
    const { category, title } = req.params;
    const pdfFile = req.files.pdfFile;
    
    const sanitizedCategory = sanitizeFilename(category);
    const sanitizedTitle = sanitizeFilename(title);
    const syllabusKey = `${sanitizedCategory}/${sanitizedTitle}`;
    
    // Check if syllabus exists
    const syllabusSnapshot = await pdfSyllabusRef.child(syllabusKey).once('value');
    const syllabusData = syllabusSnapshot.val();
    
    if (!syllabusData) {
      return res.status(404).json({ error: "PDF syllabus not found" });
    }
    
    // Delete old file from storage if it exists
    if (syllabusData.filePath) {
      try {
        await bucket.file(syllabusData.filePath).delete();
      } catch (deleteError) {
        console.warn("Failed to delete old file, it might not exist:", deleteError);
      }
    }
    
    // Upload new file to Firebase Storage
    const timestamp = Date.now();
    const filePath = `pdfsyllabi/${sanitizedCategory}/${sanitizedTitle}_${timestamp}.pdf`;
    const fileBuffer = Buffer.from(pdfFile.data);
    const file = bucket.file(filePath);
    
    await file.save(fileBuffer, {
      metadata: {
        contentType: 'application/pdf',
        metadata: {
          originalName: pdfFile.name,
          category,
          title
        }
      }
    });
    
    // Get the public URL of the file
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: '03-01-2500' // Long expiration date
    });
    
    // Update syllabus data with new file info
    const updatedData = {
      ...syllabusData,
      filePath,
      fileUrl: url,
      updatedAt: timestamp
    };
    
    await pdfSyllabusRef.child(syllabusKey).update(updatedData);
    
    res.json({
      message: "PDF file updated successfully",
      data: {
        id: syllabusKey,
        ...updatedData
      }
    });
    
  } catch (error) {
    console.error("Error updating PDF file:", error);
    res.status(500).json({ error: "Failed to update PDF file" });
  }
});

// Get all PDF syllabi
app.get("/api/pdf-syllabi", async (req, res) => {
  try {
    const snapshot = await pdfSyllabusRef.once('value');
    const syllabi = {};
    
    snapshot.forEach((categorySnapshot) => {
      categorySnapshot.forEach((syllabusSnapshot) => {
        const syllabusData = syllabusSnapshot.val();
        const category = syllabusData.category;
        
        if (!syllabi[category]) {
          syllabi[category] = {};
        }
        
        syllabi[category][syllabusData.title] = syllabusData;
      });
    });
    
    res.json(syllabi);
  } catch (error) {
    console.error("Error fetching PDF syllabi:", error);
    res.status(500).json({ error: "Failed to fetch PDF syllabi" });
  }
});

// Get PDF syllabi by category
app.get("/api/pdf-syllabi/category/:category", async (req, res) => {
  try {
    const { category } = req.params;
    const sanitizedCategory = sanitizeFilename(category);
    
    const snapshot = await pdfSyllabusRef.child(sanitizedCategory).once('value');
    const syllabi = {};
    
    snapshot.forEach((syllabusSnapshot) => {
      const syllabusData = syllabusSnapshot.val();
      syllabi[syllabusData.title] = syllabusData;
    });
    
    res.json(syllabi);
  } catch (error) {
    console.error("Error fetching PDF syllabi by category:", error);
    res.status(500).json({ error: "Failed to fetch PDF syllabi by category" });
  }
});

// Delete PDF syllabus
app.delete("/api/pdf-syllabi/:category/:title", async (req, res) => {
  try {
    const { category, title } = req.params;
    
    const sanitizedCategory = sanitizeFilename(category);
    const sanitizedTitle = sanitizeFilename(title);
    const syllabusKey = `${sanitizedCategory}/${sanitizedTitle}`;
    
    // Check if syllabus exists
    const syllabusSnapshot = await pdfSyllabusRef.child(syllabusKey).once('value');
    const syllabusData = syllabusSnapshot.val();
    
    if (!syllabusData) {
      return res.status(404).json({ error: "PDF syllabus not found" });
    }
    
    // Delete file from storage if it exists
    if (syllabusData.filePath) {
      try {
        await bucket.file(syllabusData.filePath).delete();
      } catch (deleteError) {
        console.warn("Failed to delete file, it might not exist:", deleteError);
      }
    }
    
    // Delete syllabus from Realtime Database
    await pdfSyllabusRef.child(syllabusKey).remove();
    
    res.json({ message: "PDF syllabus deleted successfully" });
  } catch (error) {
    console.error("Error deleting PDF syllabus:", error);
    res.status(500).json({ error: "Failed to delete PDF syllabus" });
  }
});



//Api for pdf syllabus purchasers

// API to get all PDF syllabus purchasers
app.get('/api/pdfsyllabuspurchasers', async (req, res) => {
  try {
    // Create a reference to the collection
    const ref = realtimeDatabase.ref('pdfsyllabuspurchasers');
    
    // Get all data from the reference
    const snapshot = await ref.once('value');
    
    // Convert the snapshot to JSON
    const data = snapshot.val();
    
    // If no data is found, return a 404
    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'No data found'
      });
    }
    
    // Return the data
    return res.status(200).json({
      success: true,
      data: data
    });
  } catch (error) {
    console.error('Error retrieving data:', error);
    return res.status(500).json({
      success: false,
      message: 'Error retrieving data from database',
      error: error.message
    });
  }
});





//VideoSyllabus Apis

// ✅ Firebase Realtime Database reference for video syllabus categories
const videoSyllabusCategoryRef = realtimeDatabase.ref('videosyllabuscategories');
const videoSyllabusRef = realtimeDatabase.ref('videosyllabi');

// ✅ Create a new video syllabus category
app.post("/api/videosyllabuscategories", async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Category name is required" });
    }

    const newVideoSyllabusCategoryRef = videoSyllabusCategoryRef.push();
    await newVideoSyllabusCategoryRef.set({
      name,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    res.status(201).json({
      id: newVideoSyllabusCategoryRef.key,
      name
    });
  } catch (error) {
    console.error("Error creating video syllabus category:", error);
    res.status(500).json({ error: "Failed to create video syllabus category" });
  }
});

// ✅ Get all video syllabus categories
app.get("/api/videosyllabuscategories", async (req, res) => {
  try {
    const snapshot = await videoSyllabusCategoryRef.once('value');
    const videoSyllabusCategories = [];

    snapshot.forEach((childSnapshot) => {
      videoSyllabusCategories.push({
        id: childSnapshot.key,
        ...childSnapshot.val()
      });
    });

    res.json(videoSyllabusCategories);
  } catch (error) {
    console.error("Error fetching video syllabus categories:", error);
    res.status(500).json({ error: "Failed to fetch video syllabus categories" });
  }
});

// ✅ Update a video syllabus category
app.put("/api/videosyllabuscategories/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Category name is required" });
    }

    const videoCategoryRef = videoSyllabusCategoryRef.child(id);
    await videoCategoryRef.update({
      name,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });

    res.json({ id, name });
  } catch (error) {
    console.error("Error updating video syllabus category:", error);
    res.status(500).json({ error: "Failed to update video syllabus category" });
  }
});

// ✅ Delete a video syllabus category
app.delete("/api/videosyllabuscategories/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await videoSyllabusCategoryRef.child(id).remove();
    res.json({ message: "Video syllabus category deleted successfully" });
  } catch (error) {
    console.error("Error deleting video syllabus category:", error);
    res.status(500).json({ error: "Failed to delete video syllabus category" });
  }
});


// Create or update Video syllabus
// Use videoUpload.single for the video file upload route
app.post("/api/video-syllabi", videoUpload.single('videoFile'), async (req, res) => {
  try {
    // After Multer processes the file, it will be available as req.file
    if (!req.file) {
      return res.status(400).json({ error: "Video file is required" });
    }
    
    const { category, title, fees, duration } = req.body;
    
    if (!category || !title) {
      return res.status(400).json({ error: "Category and title are required" });
    }
    
    // The file data is now in req.file
    const videoFile = req.file;
    const timestamp = Date.now();
    const sanitizedTitle = sanitizeFilename(title);
    const sanitizedCategory = sanitizeFilename(category);
    
    // Get file extension from original filename
    const fileExtension = videoFile.originalname.split('.').pop();
    
    // Create a unique file path in Firebase Storage
    const filePath = `videosyllabi/${sanitizedCategory}/${sanitizedTitle}_${timestamp}.${fileExtension}`;
    
    // Upload file to Firebase Storage
    const fileBuffer = videoFile.buffer; // With Multer, file data is in the buffer property
    const file = bucket.file(filePath);
    
    await file.save(fileBuffer, {
      metadata: {
        contentType: videoFile.mimetype || 'video/mp4',
        metadata: {
          originalName: videoFile.originalname, // With Multer, the file name is in originalname property
          category,
          title
        }
      }
    });
    
    // Get the public URL of the file
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: '03-01-2500' // Long expiration date
    });
    
    // Create syllabus entry in Realtime Database
    const syllabusData = {
      title,
      category,
      fees: parseFloat(fees) || 0,
      duration: duration ? `${duration} days` : "N/A",
      filePath,
      fileUrl: url,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    
    const syllabusKey = `${sanitizedCategory}/${sanitizedTitle}`;
    await videoSyllabusRef.child(syllabusKey).set(syllabusData);
    
    res.status(201).json({
      message: "Video syllabus created successfully",
      data: {
        id: syllabusKey,
        ...syllabusData
      }
    });
  } catch (error) {
    console.error("Error creating video syllabus:", error);
    res.status(500).json({ error: "Failed to create video syllabus" });
  }
});

// Update Video syllabus
app.put("/api/video-syllabi/:category/:title", async (req, res) => {
  try {
    const { category, title } = req.params;
    const { newCategory, newTitle, fees, duration } = req.body;
    
    if (!newCategory || !newTitle) {
      return res.status(400).json({ error: "Category and title are required" });
    }
    
    const sanitizedOldCategory = sanitizeFilename(category);
    const sanitizedOldTitle = sanitizeFilename(title);
    const oldSyllabusKey = `${sanitizedOldCategory}/${sanitizedOldTitle}`;
    
    // Check if syllabus exists
    const syllabusSnapshot = await videoSyllabusRef.child(oldSyllabusKey).once('value');
    const syllabusData = syllabusSnapshot.val();
    
    if (!syllabusData) {
      return res.status(404).json({ error: "Video syllabus not found" });
    }
    
    // Update metadata
    const updatedData = {
      ...syllabusData,
      title: newTitle,
      category: newCategory,
      fees: parseFloat(fees) || 0,
      duration: duration ? `${duration} days` : "N/A",
      updatedAt: Date.now()
    };
    
    // If category or title changed, we need to create a new entry and delete the old one
    if (category !== newCategory || title !== newTitle) {
      const sanitizedNewCategory = sanitizeFilename(newCategory);
      const sanitizedNewTitle = sanitizeFilename(newTitle);
      const newSyllabusKey = `${sanitizedNewCategory}/${sanitizedNewTitle}`;
      
      // Create new entry with updated data
      await videoSyllabusRef.child(newSyllabusKey).set(updatedData);
      
      // Delete old entry
      await videoSyllabusRef.child(oldSyllabusKey).remove();
      
      res.json({
        message: "Video syllabus updated successfully",
        data: {
          id: newSyllabusKey,
          ...updatedData
        }
      });
    } else {
      // Update existing entry
      await videoSyllabusRef.child(oldSyllabusKey).update(updatedData);
      
      res.json({
        message: "Video syllabus updated successfully",
        data: {
          id: oldSyllabusKey,
          ...updatedData
        }
      });
    }
    
  } catch (error) {
    console.error("Error updating video syllabus:", error);
    res.status(500).json({ error: "Failed to update video syllabus" });
  }
});

// Replace Video file for existing syllabus
app.put("/api/video-syllabi/:category/:title/file", videoUpload.single('videoFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Video file is required" });
    }
    
    const { category, title } = req.params;
    const videoFile = req.file;
    
    const sanitizedCategory = sanitizeFilename(category);
    const sanitizedTitle = sanitizeFilename(title);
    const syllabusKey = `${sanitizedCategory}/${sanitizedTitle}`;
    
    // Check if syllabus exists
    const syllabusSnapshot = await videoSyllabusRef.child(syllabusKey).once('value');
    const syllabusData = syllabusSnapshot.val();
    
    if (!syllabusData) {
      return res.status(404).json({ error: "Video syllabus not found" });
    }
    
    // Delete old file from storage if it exists
    if (syllabusData.filePath) {
      try {
        await bucket.file(syllabusData.filePath).delete();
      } catch (deleteError) {
        console.warn("Failed to delete old file, it might not exist:", deleteError);
      }
    }
    
    // Upload new file to Firebase Storage
    const timestamp = Date.now();
    const fileExtension = videoFile.originalname.split('.').pop();
    const filePath = `videosyllabi/${sanitizedCategory}/${sanitizedTitle}_${timestamp}.${fileExtension}`;
    const fileBuffer = videoFile.buffer;
    const file = bucket.file(filePath);
    
    await file.save(fileBuffer, {
      metadata: {
        contentType: videoFile.mimetype || 'video/mp4',
        metadata: {
          originalName: videoFile.originalname,
          category,
          title
        }
      }
    });
    
    // Get the public URL of the file
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: '03-01-2500' // Long expiration date
    });
    
    // Update syllabus data with new file info
    const updatedData = {
      ...syllabusData,
      filePath,
      fileUrl: url,
      updatedAt: timestamp
    };
    
    await videoSyllabusRef.child(syllabusKey).update(updatedData);
    
    res.json({
      message: "Video file updated successfully",
      data: {
        id: syllabusKey,
        ...updatedData
      }
    });
    
  } catch (error) {
    console.error("Error updating video file:", error);
    res.status(500).json({ error: "Failed to update video file" });
  }
});

// Get all Video syllabi
app.get("/api/video-syllabi", async (req, res) => {
  try {
    const snapshot = await videoSyllabusRef.once('value');
    const syllabi = {};
    
    snapshot.forEach((categorySnapshot) => {
      categorySnapshot.forEach((syllabusSnapshot) => {
        const syllabusData = syllabusSnapshot.val();
        const category = syllabusData.category;
        
        if (!syllabi[category]) {
          syllabi[category] = {};
        }
        
        syllabi[category][syllabusData.title] = syllabusData;
      });
    });
    
    res.json(syllabi);
  } catch (error) {
    console.error("Error fetching video syllabi:", error);
    res.status(500).json({ error: "Failed to fetch video syllabi" });
  }
});

// Get Video syllabi by category
app.get("/api/video-syllabi/category/:category", async (req, res) => {
  try {
    const { category } = req.params;
    const sanitizedCategory = sanitizeFilename(category);
    
    const snapshot = await videoSyllabusRef.child(sanitizedCategory).once('value');
    const syllabi = {};
    
    snapshot.forEach((syllabusSnapshot) => {
      const syllabusData = syllabusSnapshot.val();
      syllabi[syllabusData.title] = syllabusData;
    });
    
    res.json(syllabi);
  } catch (error) {
    console.error("Error fetching video syllabi by category:", error);
    res.status(500).json({ error: "Failed to fetch video syllabi by category" });
  }
});

// Delete Video syllabus
app.delete("/api/video-syllabi/:category/:title", async (req, res) => {
  try {
    const { category, title } = req.params;
    
    const sanitizedCategory = sanitizeFilename(category);
    const sanitizedTitle = sanitizeFilename(title);
    const syllabusKey = `${sanitizedCategory}/${sanitizedTitle}`;
    
    // Check if syllabus exists
    const syllabusSnapshot = await videoSyllabusRef.child(syllabusKey).once('value');
    const syllabusData = syllabusSnapshot.val();
    
    if (!syllabusData) {
      return res.status(404).json({ error: "Video syllabus not found" });
    }
    
    // Delete file from storage if it exists
    if (syllabusData.filePath) {
      try {
        await bucket.file(syllabusData.filePath).delete();
      } catch (deleteError) {
        console.warn("Failed to delete file, it might not exist:", deleteError);
      }
    }
    
    // Delete syllabus from Realtime Database
    await videoSyllabusRef.child(syllabusKey).remove();
    
    res.json({ message: "Video syllabus deleted successfully" });
  } catch (error) {
    console.error("Error deleting video syllabus:", error);
    res.status(500).json({ error: "Failed to delete video syllabus" });
  }
});



//Video syllbus user apis

// =============================
// 🎬 VIDEO PURCHASE APIS
// =============================

// Firebase Realtime Database references
const videoSyllabusPurchasersRef = realtimeDatabase.ref('videosyllabuspurchasers');

// 1️⃣ Verify video student
app.get('/api/video-verify-student/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const studentSnapshot = await videoSyllabusPurchasersRef.child(studentId).once('value');
    const studentData = studentSnapshot.val();

    if (studentData) {
      return res.json({
        exists: true,
        studentDetails: {
          studentId,
          ...studentData
        }
      });
    } else {
      return res.json({ exists: false });
    }
  } catch (error) {
    console.error('Error verifying video student:', error);
    return res.status(500).json({
      error: 'Failed to verify video student ID',
      message: error.message
    });
  }
});

// 2️⃣ Register new video student
app.post('/api/video-register-student', async (req, res) => {
  try {
    const studentData = req.body;
    let studentId;
    let isUnique = false;

    while (!isUnique) {
      studentId = Math.floor(100000 + Math.random() * 900000).toString();
      const existing = await videoSyllabusPurchasersRef.child(studentId).once('value');
      if (!existing.exists()) isUnique = true;
    }

    await videoSyllabusPurchasersRef.child(studentId).set({
      name: studentData.name,
      age: studentData.age,
      gender: studentData.gender,
      phoneNo: studentData.phoneNo,
      email: studentData.email || null,
      district: studentData.district,
      state: studentData.state,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    return res.json({
      success: true,
      message: 'Video student registered successfully',
      studentId
    });
  } catch (error) {
    console.error('Error registering video student:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to register video student',
      message: error.message
    });
  }
});

// 3️⃣ Update student details
app.put('/api/video-update-student/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const updatedData = req.body;

    const studentSnapshot = await videoSyllabusPurchasersRef.child(studentId).once('value');
    if (!studentSnapshot.exists()) {
      return res.status(404).json({ success: false, error: 'Video student not found' });
    }

    await videoSyllabusPurchasersRef.child(studentId).update({
      ...updatedData,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });

    const updatedStudent = (await videoSyllabusPurchasersRef.child(studentId).once('value')).val();

    return res.json({
      success: true,
      message: 'Video student details updated successfully',
      studentDetails: { studentId, ...updatedStudent }
    });
  } catch (error) {
    console.error('Error updating video student:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to update video student',
      message: error.message
    });
  }
});

// 4️⃣ Create a new video order
app.post('/api/create-video-order', async (req, res) => {
  try {
    const { amount, notes } = req.body;
    const options = {
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `video_receipt_${Date.now()}`,
      notes
    };

    const order = await razorpay.orders.create(options);
    return res.json({ success: true, order });
  } catch (error) {
    console.error('Error creating video order:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to create video payment order',
      message: error.message
    });
  }
});

// 5️⃣ Verify video payment
app.post('/api/verify-video-payment', async (req, res) => {
  try {
    const { orderId, paymentId, signature, syllabusId, filePath, userId } = req.body;

    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    if (generatedSignature !== signature) {
      return res.status(400).json({ success: false, error: 'Invalid video payment signature' });
    }

    return res.json({
      success: true,
      message: 'Video payment verified successfully',
      paymentId,
      syllabusId,
      userId
    });
  } catch (error) {
    console.error('Error verifying video payment:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to verify video payment',
      message: error.message
    });
  }
});

// 6️⃣ Save video syllabus purchase
app.post('/api/video-save-syllabus-purchase', async (req, res) => {
  try {
    const { studentId, syllabusDetails, paymentDetails, purchaseDate } = req.body;
    const purchaseId = uuidv4();

    const purchaseData = {
      purchaseId,
      syllabusId: syllabusDetails.id,
      syllabusTitle: syllabusDetails.title,
      syllabusCategory: syllabusDetails.category,
      syllabusPrice: syllabusDetails.fees,
      syllabusDuration: syllabusDetails.duration,
      syllabusDescription: syllabusDetails.description || '',
      syllabusFilePath: syllabusDetails.filePath,
      syllabusFileUrl: syllabusDetails.fileUrl,
      paymentStatus: paymentDetails.status,
      paymentAmount: paymentDetails.amount,
      paymentId: paymentDetails.paymentId || null,
      orderId: paymentDetails.orderId || null,
      purchaseDate,
      createdAt: admin.database.ServerValue.TIMESTAMP
    };

    await videoSyllabusPurchasersRef
      .child(studentId)
      .child('purchases')
      .child(purchaseId)
      .set(purchaseData);

    return res.json({
      success: true,
      message: 'Video syllabus purchase saved successfully',
      purchaseId
    });
  } catch (error) {
    console.error('Error saving video purchase:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to save video syllabus purchase',
      message: error.message
    });
  }
});

// 7️⃣ Get student's purchased video syllabi
app.get('/api/video-student-purchases/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const purchasesSnapshot = await videoSyllabusPurchasersRef
      .child(studentId)
      .child('purchases')
      .once('value');

    const purchases = purchasesSnapshot.val() || {};
    return res.json({
      success: true,
      purchases: Object.values(purchases)
    });
  } catch (error) {
    console.error('Error fetching video student purchases:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch video student purchases',
      message: error.message
    });
  }
});

// 8️⃣ Get all video syllabus purchasers (admin/debug view)
app.get('/api/videosyllabuspurchasers', async (req, res) => {
  try {
    const snapshot = await videoSyllabusPurchasersRef.once('value');
    const data = snapshot.val();

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'No video syllabus purchasers found'
      });
    }

    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error retrieving video purchasers:', error);
    return res.status(500).json({
      success: false,
      message: 'Error retrieving video purchasers',
      error: error.message
    });
  }
});



// Start the server
app.listen(port, () => {
    console.log(`Server started on port ${port}`);
});
