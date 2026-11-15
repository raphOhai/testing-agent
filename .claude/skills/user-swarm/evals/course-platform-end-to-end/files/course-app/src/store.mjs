// In-memory data store (staging copy; restarts empty).
export const db = {
  learners: new Map(),     // id → { id, fullName, email, password, verified, verifyToken, createdAt, lastLoginAt }
  sessions: new Map(),     // token → learnerId
  courses: new Map(),      // id → { id, title, priceCents, lessons }
  enrollments: new Map(),  // id → { id, learnerId, courseId, status, priceCents, createdAt, paidAt, lessonsDone, lastActivityAt }
};
