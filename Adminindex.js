const express = require("express");
const cors = require("cors");
const multer = require("multer");
const admin = require("./db/firebaseConfig").firebaseAdmin;
const moment = require("moment")
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');

// Initialize Express app
const app = express();
const port = 5555;

// Middleware
app.use(express.json());
app.use(cors());


// Multer setup for image upload
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // Limit: 5 MB
});


// Multer setup for file uploads
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // Limit: 10 MB
  fileFilter: (req, file, cb) => {
    // Accept only PDF files
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Firestore setup
const firestore = admin.firestore();
const realtimeDatabase = admin.database();
const bucket = admin.storage().bucket();


app.get("/", (req, res) => {
  res.send("Node.js backend is running successfully!");
});


// API to add a question to a specific exam
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
app.post("/api/notifications", async (req, res) => {
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
  app.put("/api/notifications/:id", async (req, res) => {
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

app.get("/api/exams", async (req, res) => {
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

const practiceTestsRef = realtimeDatabase.ref('PracticeTests');

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
const pdfSyllabusRef = realtimeDatabase.ref('pdfsyllabi');

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
