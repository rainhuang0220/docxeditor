export const DOCUMENT_TEMPLATES = {
  blank: {
    name: 'Blank Document',
    content: `<h1>Untitled Document</h1><p></p>`,
  },
  report: {
    name: 'Report',
    content: `
      <h1 style="text-align: center">Report Title</h1>
      <p style="text-align: center"><em>Author Name</em></p>
      <p style="text-align: center"><em>Date</em></p>
      <p></p>
      <h2>1. Executive Summary</h2>
      <p>Provide a brief overview of the report's key findings and recommendations.</p>
      <p></p>
      <h2>2. Introduction</h2>
      <p>Describe the background, objectives, and scope of this report.</p>
      <p></p>
      <h2>3. Methodology</h2>
      <p>Explain the methods and approach used.</p>
      <p></p>
      <h2>4. Findings</h2>
      <p>Present the main findings and analysis.</p>
      <p></p>
      <h2>5. Conclusions</h2>
      <p>Summarize the key conclusions drawn from the findings.</p>
      <p></p>
      <h2>6. Recommendations</h2>
      <p>Provide actionable recommendations based on the conclusions.</p>
    `,
  },
  proposal: {
    name: 'Proposal',
    content: `
      <h1 style="text-align: center">Project Proposal</h1>
      <p style="text-align: center"><strong>Prepared by:</strong> Your Name</p>
      <p style="text-align: center"><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
      <p></p>
      <h2>Project Overview</h2>
      <p>Describe the project and its objectives.</p>
      <p></p>
      <h2>Problem Statement</h2>
      <p>Define the problem this project aims to solve.</p>
      <p></p>
      <h2>Proposed Solution</h2>
      <p>Outline the proposed solution and approach.</p>
      <p></p>
      <h2>Timeline</h2>
      <p>Provide a high-level timeline with key milestones.</p>
      <p></p>
      <h2>Budget</h2>
      <p>Detail the estimated costs and resource requirements.</p>
      <p></p>
      <h2>Expected Outcomes</h2>
      <p>Describe the expected results and benefits.</p>
    `,
  },
  letter: {
    name: 'Formal Letter',
    content: `
      <p style="text-align: right">[Your Address]</p>
      <p style="text-align: right">[City, State ZIP]</p>
      <p style="text-align: right">[Date]</p>
      <p></p>
      <p>[Recipient Name]</p>
      <p>[Recipient Title]</p>
      <p>[Company/Organization]</p>
      <p>[Address]</p>
      <p></p>
      <p>Dear [Recipient],</p>
      <p></p>
      <p>[Body of the letter. State your purpose clearly in the first paragraph.]</p>
      <p></p>
      <p>[Provide supporting details in subsequent paragraphs.]</p>
      <p></p>
      <p>[Conclude with a call to action or summary.]</p>
      <p></p>
      <p>Sincerely,</p>
      <p></p>
      <p>[Your Name]</p>
      <p>[Your Title]</p>
    `,
  },
  academic: {
    name: 'Academic Paper',
    content: `
      <h1 style="text-align: center">Paper Title</h1>
      <p style="text-align: center"><em>Author Name<sup>1</sup></em></p>
      <p style="text-align: center"><em><sup>1</sup>Institution, City, Country</em></p>
      <p></p>
      <h2>Abstract</h2>
      <p>Write a concise summary of the paper (150-300 words).</p>
      <p></p>
      <p><strong>Keywords:</strong> keyword1, keyword2, keyword3</p>
      <p></p>
      <h2>1. Introduction</h2>
      <p>Introduce the research topic and state the research questions or hypotheses.</p>
      <p></p>
      <h2>2. Literature Review</h2>
      <p>Review relevant prior work and identify gaps.</p>
      <p></p>
      <h2>3. Methodology</h2>
      <p>Describe the research methods, data collection, and analysis approach.</p>
      <p></p>
      <h2>4. Results</h2>
      <p>Present findings with supporting data.</p>
      <p></p>
      <h2>5. Discussion</h2>
      <p>Interpret results, discuss implications, and address limitations.</p>
      <p></p>
      <h2>6. Conclusion</h2>
      <p>Summarize contributions and suggest future research directions.</p>
      <p></p>
      <h2>References</h2>
      <p>[1] Author, A. (Year). Title. Journal, Volume(Issue), Pages.</p>
    `,
  },
}
