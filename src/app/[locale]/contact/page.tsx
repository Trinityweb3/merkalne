import type { Metadata } from 'next'
import { ContactForm } from '@/components/site/contact-form'

export const metadata: Metadata = {
  title: 'Contact & report',
  description: 'Contact the Merklane team or report suspicious material.',
}

export default function ContactPage() {
  return (
    <div className="container page">
      <div className="page-head">
        <div>
          <h1>Contact &amp; report</h1>
          <p>
            Questions, feedback, partnership ideas or something that looks wrong — this form
            reaches the team directly. For material on the site, the fastest route is the
            “Report” button on the post itself.
          </p>
        </div>
      </div>
      <div className="narrow">
        <ContactForm />
      </div>
    </div>
  )
}
