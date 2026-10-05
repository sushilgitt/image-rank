import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <p className={styles.eyebrow}>◆ Image Rank</p>
        <h1 className={styles.heading}>Lighter images. Higher rankings.</h1>
        <p className={styles.text}>
          The image optimization & SEO suite for Shopify. Compress to WebP, write AI alt text, and track page speed.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>AI alt text</strong> Generate SEO-optimized alt text for product images using AI vision.
          </li>
          <li>
            <strong>Smart compression</strong> Reduce image sizes by up to 70% with automatic WebP conversion.
          </li>
          <li>
            <strong>Page speed reports</strong> Track Core Web Vitals and PageSpeed improvements in real-time.
          </li>
        </ul>
      </div>
    </div>
  );
}
