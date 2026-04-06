import jsPDF from "jspdf";

interface StudyKit {
  summary: string;
  flashcards: { question: string; answer: string }[];
  quiz: { question: string; options: string[]; answer: string }[];
  mindmap: string;
  practice_questions: string[];
  study_plan: string;
}

export function generateStudyKitPDF(data: StudyKit, fileName: string) {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = 20;

  const checkPage = (needed: number) => {
    if (y + needed > 270) {
      doc.addPage();
      y = 20;
    }
  };

  const addTitle = (text: string) => {
    checkPage(20);
    doc.setFontSize(18);
    doc.setFont("helvetica", "bold");
    doc.text(text, margin, y);
    y += 10;
    doc.setDrawColor(100, 100, 200);
    doc.line(margin, y, pageWidth - margin, y);
    y += 8;
  };

  const addText = (text: string, fontSize = 11) => {
    doc.setFontSize(fontSize);
    doc.setFont("helvetica", "normal");
    const lines = doc.splitTextToSize(text, contentWidth);
    for (const line of lines) {
      checkPage(7);
      doc.text(line, margin, y);
      y += 6;
    }
    y += 4;
  };

  // Title page
  doc.setFontSize(28);
  doc.setFont("helvetica", "bold");
  doc.text("AI Study Kit", pageWidth / 2, 60, { align: "center" });
  doc.setFontSize(14);
  doc.setFont("helvetica", "normal");
  doc.text(fileName, pageWidth / 2, 75, { align: "center" });
  doc.setFontSize(10);
  doc.text(`Generated on ${new Date().toLocaleDateString()}`, pageWidth / 2, 85, { align: "center" });

  // Summary
  doc.addPage();
  y = 20;
  addTitle("Summary");
  addText(data.summary);

  // Flashcards
  addTitle("Flashcards");
  data.flashcards.forEach((card, i) => {
    checkPage(20);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    const qLines = doc.splitTextToSize(`Q${i + 1}: ${card.question}`, contentWidth);
    for (const line of qLines) {
      checkPage(7);
      doc.text(line, margin, y);
      y += 6;
    }
    doc.setFont("helvetica", "normal");
    const aLines = doc.splitTextToSize(`A: ${card.answer}`, contentWidth);
    for (const line of aLines) {
      checkPage(7);
      doc.text(line, margin, y);
      y += 6;
    }
    y += 4;
  });

  // Quiz
  addTitle("Quiz");
  const letters = ['A', 'B', 'C', 'D'];
  data.quiz.forEach((q, i) => {
    checkPage(30);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    const qLines = doc.splitTextToSize(`${i + 1}. ${q.question}`, contentWidth);
    for (const line of qLines) {
      checkPage(7);
      doc.text(line, margin, y);
      y += 6;
    }
    doc.setFont("helvetica", "normal");
    q.options.forEach((opt, j) => {
      checkPage(7);
      const prefix = letters[j] === q.answer ? `${letters[j]}. ✓ ` : `${letters[j]}. `;
      doc.text(prefix + opt, margin + 5, y);
      y += 6;
    });
    y += 4;
  });

  // Mind Map
  addTitle("Mind Map Outline");
  addText(data.mindmap);

  // Practice Questions
  addTitle("Practice Questions");
  data.practice_questions.forEach((q, i) => {
    checkPage(14);
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    const lines = doc.splitTextToSize(`${i + 1}. ${q}`, contentWidth);
    for (const line of lines) {
      checkPage(7);
      doc.text(line, margin, y);
      y += 6;
    }
    y += 4;
  });

  // Study Plan
  addTitle("7-Day Study Plan");
  addText(data.study_plan);

  doc.save(`study-kit-${fileName.replace(/\.[^.]+$/, '')}.pdf`);
}
