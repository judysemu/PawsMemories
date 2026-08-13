import React from "react";
import { ChevronLeft, ExternalLink } from "lucide-react";
import type { PawprintPrintProduct } from "../../../shared/pawprintCatalog2";
import { SHOPIFY_STOREFRONT_ALL_PRODUCTS_URL } from "../../../shared/pawprintCatalog2";
import { CategoryOptionPicker, CustomizeChoice } from "./DigitalCategoryStep";

export function PrintProductStep({
  products, productsLoading, productsError, shopifyProductId, categoryId, optionId, customizeChosen,
  onChooseProduct, onChooseOption, onChooseCustomize, onContinue, onBack,
}: {
  products: PawprintPrintProduct[];
  productsLoading: boolean;
  productsError: string;
  shopifyProductId: string;
  categoryId: string;
  optionId: string;
  customizeChosen: boolean | null;
  onChooseProduct: (shopifyProductId: string) => void;
  onChooseOption: (categoryId: string, optionId: string) => void;
  onChooseCustomize: (customize: boolean) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const selectedProduct = products.find((item) => item.shopifyProductId === shopifyProductId);
  const canContinue = Boolean(shopifyProductId && categoryId && optionId && customizeChosen !== null);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-28 pt-8">
      <button onClick={onBack} className="mb-6 flex min-h-11 items-center gap-2 text-sm font-black text-primary"><ChevronLeft size={18} /> Back</button>
      <div className="mb-8 max-w-2xl">
        <p className="text-xs font-black uppercase tracking-[.2em] text-primary">Print Pawprint</p>
        <h1 className="mt-2 text-3xl font-black text-on-surface">Choose your product</h1>
        <p className="mt-2 text-on-surface-variant">Each product offers its own set of themes — pick a product first to see its options.</p>
      </div>

      {productsLoading ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-24 animate-pulse rounded-2xl border border-outline-variant/30 bg-surface-container" />
          ))}
        </div>
      ) : productsError ? (
        <p className="rounded-2xl border border-error/30 bg-error/10 p-4 text-sm font-bold text-error">{productsError}</p>
      ) : products.length === 0 ? (
        <p className="rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4 text-sm font-semibold text-on-surface-variant">
          Print products are not available yet. Check back soon, or choose Digital instead.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          {products.map((product) => (
            <button
              key={product.shopifyProductId}
              type="button"
              onClick={() => onChooseProduct(product.shopifyProductId)}
              className={`rounded-2xl border-2 p-4 text-left transition ${shopifyProductId === product.shopifyProductId ? "border-primary bg-primary/5" : "border-outline-variant/40 hover:border-primary/50"}`}
            >
              <span className="block font-black text-on-surface">{product.title}</span>
              <span className="mt-1 block text-xs text-on-surface-variant">{product.description}</span>
            </button>
          ))}
        </div>
      )}

      {selectedProduct && (
        <>
          <div className="mt-8">
            <CategoryOptionPicker
              categories={selectedProduct.categories}
              categoryId={categoryId}
              optionId={optionId}
              onChoose={onChooseOption}
              heading={selectedProduct.title}
              subheading="Choose a theme for this product"
            />
          </div>
          <CustomizeChoice customizeChosen={customizeChosen} onChoose={onChooseCustomize} />
        </>
      )}

      <button
        type="button"
        onClick={onContinue}
        disabled={!canContinue}
        className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-6 font-black text-on-primary disabled:opacity-40 sm:w-auto"
      >
        Continue
      </button>

      <a
        href={SHOPIFY_STOREFRONT_ALL_PRODUCTS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-6 flex items-center gap-1.5 text-sm font-bold text-primary underline underline-offset-2"
      >
        Looking for something else? Shop our full pet collection <ExternalLink size={14} />
      </a>
    </div>
  );
}
